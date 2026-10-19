import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { BEDROCK_MODEL_ID, NOVA_PRO_MODEL_ID } from "../../bedrock/src/client.ts";
import { SupplierFactsSchema, TenderRequirementsSchema } from "../../extraction/src/schema.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { evaluateCompliance, metrics, sumCounts, type Counts } from "./compliance.ts";
import { evaluateAssessment } from "./evaluate.ts";
import { evaluateRetrieval } from "./retrieval.ts";

const modelIds = [BEDROCK_MODEL_ID, NOVA_PRO_MODEL_ID] as const;
const modes = ["full", "rag"] as const;
const nonnegative = z.number().finite().nonnegative();
const attemptSchema = z
  .object({
    modelId: z.string().min(1),
    latencyMs: nonnegative.optional(),
    tokenUsage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    costEstimate: z.object({ estimatedUsd: nonnegative }).passthrough().nullable().optional(),
    rawResponse: z.unknown().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
const recoverySchema = z.object({
  retried: z.boolean(),
  unresolvedFields: z.array(z.string()),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(modes),
    modelId: z.string().optional(),
    endToEndLatencyMs: nonnegative.optional(),
    knownEstimatedCostUsd: nonnegative.optional(),
    totalEstimatedCostUsd: nonnegative.nullable().optional(),
    tender: z
      .object({
        documentId: z.literal("tender").optional(),
        extracted: TenderRequirementsSchema.nullable(),
        validation: z
          .object({ valid: z.boolean(), errors: z.array(z.string()).optional() })
          .passthrough(),
        attempts: z.array(attemptSchema).min(1).optional(),
        groups: z
          .object({
            general: z
              .object({
                attempts: z.array(attemptSchema).optional(),
                recovery: recoverySchema.optional(),
              })
              .passthrough(),
            compliance: z
              .object({
                attempts: z.array(attemptSchema).optional(),
                recovery: recoverySchema.optional(),
              })
              .passthrough(),
          })
          .optional(),
      })
      .passthrough(),
    supplier: z
      .object({
        documentId: z.string().min(1),
        extracted: SupplierFactsSchema.nullable(),
        validation: z
          .object({ valid: z.boolean(), errors: z.array(z.string()).optional() })
          .passthrough(),
        attempts: z.array(attemptSchema).min(1).optional(),
        recovery: recoverySchema.optional(),
      })
      .passthrough(),
    assessment: z
      .object({
        status: z.string(),
        findings: z.array(z.object({ type: z.string() }).passthrough()),
      })
      .passthrough(),
    retrieval: z.unknown().optional(),
  })
  .passthrough();

export const ExperimentManifestSchema = z.object({
  experimentId: z.string().trim().min(1),
  runs: z
    .array(
      z.object({
        runId: z.string().trim().min(1),
        report: z.string().trim().min(1),
        pairId: z.string().trim().min(1).optional(),
        expectedModelId: z.enum(modelIds).optional(),
        expectedMode: z.enum(modes).optional(),
        expectedSupplierId: z.string().trim().min(1).optional(),
      }),
    )
    .min(1),
});
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;
type Entry = {
  runId: string;
  report: unknown;
  pairId?: string | undefined;
  expectedModelId?: string | undefined;
  expectedMode?: string | undefined;
  expectedSupplierId?: string | undefined;
};
type Reference = Parameters<typeof evaluateAssessment>[1] &
  Parameters<typeof evaluateCompliance>[1];
type Sources = { tender: ExtractedPdf; suppliers: Record<string, ExtractedPdf> };

function statistics(values: (number | null)[]) {
  const available = values.filter((value): value is number => value !== null);
  const mean = available.length
    ? available.reduce((sum, value) => sum + value, 0) / available.length
    : null;
  return {
    available: available.length,
    total: values.length,
    mean,
    min: available.length ? Math.min(...available) : null,
    max: available.length ? Math.max(...available) : null,
    sampleStandardDeviation:
      available.length > 1 && mean !== null
        ? Math.sqrt(
            available.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (available.length - 1),
          )
        : null,
  };
}

const difference = (left: number | null, right: number | null) =>
  left === null || right === null ? null : right - left;

export function evaluateExperiments(
  experimentId: string,
  entries: readonly Entry[],
  reference: Reference,
  retrievalReference: unknown,
  sources: Sources,
) {
  if (!experimentId.trim() || entries.length === 0)
    throw new Error("Experiment ID and runs are required.");
  const seenRuns = new Set<string>();
  const seenReports: { runId: string; report: unknown }[] = [];
  const seenPairs = new Set<string>();
  const runs = entries.map((entry) => {
    if (!entry.runId.trim() || seenRuns.has(entry.runId))
      throw new Error(`Duplicate or empty run ID: ${entry.runId}.`);
    seenRuns.add(entry.runId);
    const duplicate = seenReports.find((prior) => isDeepStrictEqual(prior.report, entry.report));
    if (duplicate)
      throw new Error(`Run ${entry.runId}: report contents duplicate run ${duplicate.runId}.`);
    seenReports.push({ runId: entry.runId, report: entry.report });
    const report = reportSchema.parse(entry.report);
    const generalAttempts = report.tender.groups?.general.attempts;
    const complianceAttempts = report.tender.groups?.compliance.attempts;
    if ((generalAttempts === undefined) !== (complianceAttempts === undefined)) {
      throw new Error(`Run ${entry.runId}: incomplete tender group attempt metadata.`);
    }
    if (
      report.tender.attempts &&
      generalAttempts &&
      complianceAttempts &&
      !isDeepStrictEqual(report.tender.attempts, [...generalAttempts, ...complianceAttempts])
    ) {
      throw new Error(`Run ${entry.runId}: tender attempt history contradicts group attempts.`);
    }
    const attempts =
      report.tender.attempts && report.supplier.attempts
        ? [...report.tender.attempts, ...report.supplier.attempts]
        : null;
    if ((report.tender.attempts === undefined) !== (report.supplier.attempts === undefined)) {
      throw new Error(
        `Run ${entry.runId}: tender and supplier attempt lists must both be present or absent.`,
      );
    }
    const identities = [
      ...(report.modelId ? [report.modelId] : []),
      ...(attempts?.map((attempt) => attempt.modelId) ?? []),
      ...(report.tender.groups?.general.attempts?.map((attempt) => attempt.modelId) ?? []),
      ...(report.tender.groups?.compliance.attempts?.map((attempt) => attempt.modelId) ?? []),
    ];
    if (identities.length === 0) throw new Error(`Run ${entry.runId}: model metadata is missing.`);
    if (new Set(identities).size !== 1)
      throw new Error(`Run ${entry.runId}: conflicting model identifiers.`);
    const modelId = identities[0]!;
    if (!modelIds.includes(modelId as (typeof modelIds)[number])) {
      throw new Error(`Run ${entry.runId}: unsupported model ID ${modelId}.`);
    }
    if (entry.expectedModelId && entry.expectedModelId !== modelId)
      throw new Error(`Run ${entry.runId}: expected model ID does not match the report.`);
    if (entry.expectedMode && entry.expectedMode !== report.mode)
      throw new Error(`Run ${entry.runId}: expected mode does not match the report.`);
    if (entry.expectedSupplierId && entry.expectedSupplierId !== report.supplier.documentId)
      throw new Error(`Run ${entry.runId}: expected supplier does not match the report.`);
    const extraction = evaluateAssessment(report, reference);
    const compliance = evaluateCompliance([report], reference).perSupplier[0]!;
    if (entry.pairId) {
      const key = `${modelId}|${report.mode}|${extraction.supplierId}|${entry.pairId}`;
      if (seenPairs.has(key))
        throw new Error(
          `Run ${entry.runId}: duplicate pair ID within one configuration and supplier.`,
        );
      seenPairs.add(key);
    }
    const supplierPdf = sources.suppliers[report.supplier.documentId];
    if (report.mode === "rag" && !supplierPdf)
      throw new Error(`Run ${entry.runId}: source PDF is unavailable.`);
    const retrieval =
      report.mode === "rag"
        ? evaluateRetrieval(report, reference, retrievalReference, sources.tender, supplierPdf!)
        : null;
    const knownCosts = attempts?.map((attempt) => attempt.costEstimate?.estimatedUsd ?? null) ?? [];
    const pricedAttempts = knownCosts.filter((cost) => cost !== null).length;
    const knownPricedSum = knownCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
    const knownEstimatedCostUsd = attempts
      ? pricedAttempts > 0
        ? knownPricedSum
        : null
      : report.knownEstimatedCostUsd && report.knownEstimatedCostUsd > 0
        ? report.knownEstimatedCostUsd
        : null;
    const totalEstimatedCostUsd = attempts
      ? pricedAttempts === attempts.length && attempts.length > 0
        ? knownPricedSum
        : null
      : (report.totalEstimatedCostUsd ?? null);
    if (
      attempts &&
      ((report.knownEstimatedCostUsd !== undefined &&
        Math.abs(report.knownEstimatedCostUsd - knownPricedSum) > 1e-9) ||
        (report.totalEstimatedCostUsd !== undefined &&
          report.totalEstimatedCostUsd !== totalEstimatedCostUsd &&
          (report.totalEstimatedCostUsd === null ||
            totalEstimatedCostUsd === null ||
            Math.abs(report.totalEstimatedCostUsd - totalEstimatedCostUsd) > 1e-9)))
    )
      throw new Error(`Run ${entry.runId}: saved cost totals contradict invocation attempts.`);
    const withUsage = attempts?.filter((attempt) => attempt.tokenUsage) ?? [];
    const usage = withUsage.length
      ? {
          inputTokens: withUsage.reduce(
            (sum, attempt) => sum + attempt.tokenUsage!.input_tokens,
            0,
          ),
          outputTokens: withUsage.reduce(
            (sum, attempt) => sum + attempt.tokenUsage!.output_tokens,
            0,
          ),
          totalTokens: withUsage.reduce(
            (sum, attempt) =>
              sum +
              (attempt.tokenUsage!.total_tokens ??
                attempt.tokenUsage!.input_tokens + attempt.tokenUsage!.output_tokens),
            0,
          ),
          observedAttempts: withUsage.length,
          complete: withUsage.length === attempts?.length,
        }
      : null;
    const timed = attempts?.filter((attempt) => attempt.latencyMs !== undefined) ?? [];
    const modelInvocationLatencyMs =
      attempts && timed.length === attempts.length
        ? timed.reduce((sum, attempt) => sum + attempt.latencyMs!, 0)
        : null;
    const recoveries = [
      report.tender.groups?.general.recovery,
      report.tender.groups?.compliance.recovery,
      report.supplier.recovery,
    ];
    const availableRecoveries = recoveries.filter((value) => value !== undefined);
    const retried = availableRecoveries.some((value) => value.retried)
      ? true
      : availableRecoveries.length === 3
        ? false
        : null;
    const unresolvedFields = [
      ...new Set(availableRecoveries.flatMap((value) => value.unresolvedFields)),
    ];
    const classifiedAttempts =
      attempts?.filter((attempt) => Object.hasOwn(attempt, "rawResponse")) ?? [];
    const invocationFailures = classifiedAttempts.length
      ? classifiedAttempts.filter((attempt) => attempt.rawResponse === null && attempt.error).length
      : null;
    const nonInvocationAttemptErrors = classifiedAttempts.length
      ? classifiedAttempts.filter((attempt) => attempt.rawResponse !== null && attempt.error).length
      : null;
    const queryRecallAt1 = retrieval
      ? statistics(retrieval.queries.map((query) => query.recallAtK[1]!.value)).mean
      : null;
    const queryRecallAt2 = retrieval
      ? statistics(retrieval.queries.map((query) => query.recallAtK[2]!.value)).mean
      : null;
    return {
      runId: entry.runId,
      pairId: entry.pairId ?? null,
      supplierId: extraction.supplierId,
      modelId,
      mode: report.mode,
      extraction: {
        tenderAccuracy: extraction.tenderAccuracy,
        supplierAccuracy: extraction.supplierAccuracy,
        combinedAccuracy: extraction.combinedAccuracy,
        incorrectFields: [
          ...extraction.tenderAccuracy.checks
            .filter((check) => !check.matches)
            .map((check) => `tender.${check.field}`),
          ...extraction.supplierAccuracy.checks
            .filter((check) => !check.matches)
            .map((check) => `supplier.${check.field}`),
        ],
        overallResult: extraction.overallResult,
        provenanceLimitations: extraction.provenanceLimitations,
      },
      compliance,
      retrieval: retrieval
        ? {
            applicability: "evaluated" as const,
            queryRecallAt1,
            queryRecallAt2,
            queries: retrieval.queries.map((query) => ({
              group: query.group,
              query: query.query,
              recallAtK: query.recallAtK,
              evidenceHitRate: query.evidenceHitRate,
            })),
            operations: retrieval.operations.map((operation) => ({
              group: operation.group,
              coverage: operation.coverage,
            })),
            overallCoverage: retrieval.overallCoverage,
          }
        : { applicability: "not_applicable" as const },
      latency: {
        endToEndMs: report.endToEndLatencyMs ?? null,
        totalModelInvocationMs: modelInvocationLatencyMs,
        recordedModelInvocationMs: timed.length
          ? timed.reduce((sum, attempt) => sum + attempt.latencyMs!, 0)
          : null,
        timedInvocations: attempts ? timed.length : null,
        retrievalMs: null,
        retrievalLatencyStatus: report.mode === "rag" ? "not_recorded" : "not_applicable",
      },
      tokens: usage,
      cost: {
        knownEstimatedNovaUsd: knownEstimatedCostUsd,
        totalEstimatedNovaUsd: totalEstimatedCostUsd,
        pricedInvocations: attempts ? pricedAttempts : null,
        titanEmbeddingRequests:
          report.mode === "rag" &&
          report.retrieval &&
          typeof report.retrieval === "object" &&
          "embeddingRequests" in report.retrieval
            ? (report.retrieval.embeddingRequests as number)
            : null,
        titanCostUsd: null,
      },
      reliability: {
        modelInvocations: attempts?.length ?? null,
        tenderAttemptProvenance:
          report.tender.attempts && generalAttempts && complianceAttempts
            ? "verified"
            : "unavailable",
        retried,
        recoveryMetadataGroups: availableRecoveries.length,
        unresolvedFields,
        unresolvedFieldsComplete: availableRecoveries.length === 3,
        invocationFailures,
        nonInvocationAttemptErrors,
        classifiedInvocations: attempts ? classifiedAttempts.length : null,
        tenderAvailable: report.tender.extracted !== null,
        supplierAvailable: report.supplier.extracted !== null,
        tenderEvidenceValid: report.tender.validation.valid,
        supplierEvidenceValid: report.supplier.validation.valid,
        assessmentStatus: report.assessment.status,
        errors: [
          ...(report.tender.validation.errors ?? []),
          ...(report.supplier.validation.errors ?? []),
        ],
      },
    };
  });

  const configurations = modelIds.flatMap((modelId) =>
    modes.map((mode) => {
      const selected = runs.filter((run) => run.modelId === modelId && run.mode === mode);
      const counts = sumCounts(selected.map((run) => run.compliance.counts));
      return {
        modelId,
        mode,
        runIds: selected.map((run) => run.runId),
        runCount: selected.length,
        distinctSupplierCount: new Set(selected.map((run) => run.supplierId)).size,
        supplierIds: [...new Set(selected.map((run) => run.supplierId))].sort(),
        extractionAccuracy: statistics(
          selected.map((run) => run.extraction.combinedAccuracy.ratio),
        ),
        compliance: metrics(counts),
        endToEndLatencyMs: statistics(selected.map((run) => run.latency.endToEndMs)),
        modelInvocationLatencyMs: statistics(
          selected.map((run) => run.latency.totalModelInvocationMs),
        ),
        totalEstimatedNovaUsd: statistics(selected.map((run) => run.cost.totalEstimatedNovaUsd)),
        knownEstimatedNovaUsd: statistics(
          selected.map((run) =>
            run.cost.pricedInvocations === 0 ? null : run.cost.knownEstimatedNovaUsd,
          ),
        ),
        recoveryFrequency: statistics(
          selected.map((run) =>
            run.reliability.retried === null ? null : Number(run.reliability.retried),
          ),
        ),
        retrievalCoverage:
          mode === "rag"
            ? statistics(
                selected.map((run) =>
                  run.retrieval.applicability === "evaluated"
                    ? run.retrieval.overallCoverage.ratio
                    : null,
                ),
              )
            : null,
        queryRecallAt1:
          mode === "rag"
            ? statistics(
                selected.map((run) =>
                  run.retrieval.applicability === "evaluated" ? run.retrieval.queryRecallAt1 : null,
                ),
              )
            : null,
        queryRecallAt2:
          mode === "rag"
            ? statistics(
                selected.map((run) =>
                  run.retrieval.applicability === "evaluated" ? run.retrieval.queryRecallAt2 : null,
                ),
              )
            : null,
      };
    }),
  );
  const comparisonKeys = [
    [0, 1],
    [2, 3],
    [0, 2],
    [1, 3],
  ] as const;
  const comparisons = comparisonKeys.map(([leftIndex, rightIndex]) => {
    const left = configurations[leftIndex]!;
    const right = configurations[rightIndex]!;
    const leftRuns = runs.filter((run) => run.modelId === left.modelId && run.mode === left.mode);
    const rightRuns = runs.filter(
      (run) => run.modelId === right.modelId && run.mode === right.mode,
    );
    const matchedSupplierIds = left.supplierIds.filter((id) => right.supplierIds.includes(id));
    const paired = leftRuns.flatMap((first) => {
      if (!first.pairId) return [];
      const second = rightRuns.find(
        (candidate) =>
          candidate.supplierId === first.supplierId && candidate.pairId === first.pairId,
      );
      if (!second) return [];
      return [
        {
          pairId: first.pairId,
          supplierId: first.supplierId,
          leftRunId: first.runId,
          rightRunId: second.runId,
          extractionAccuracyDifference: difference(
            first.extraction.combinedAccuracy.ratio,
            second.extraction.combinedAccuracy.ratio,
          ),
          complianceF1Difference: difference(
            first.compliance.counts.f1,
            second.compliance.counts.f1,
          ),
          complianceCountDifference: Object.fromEntries(
            (["tp", "fp", "fn", "tn"] as const).map((key) => [
              key,
              second.compliance.counts[key] - first.compliance.counts[key],
            ]),
          ) as Counts,
          endToEndLatencyMsDifference: difference(
            first.latency.endToEndMs,
            second.latency.endToEndMs,
          ),
          totalEstimatedNovaUsdDifference: difference(
            first.cost.totalEstimatedNovaUsd,
            second.cost.totalEstimatedNovaUsd,
          ),
        },
      ];
    });
    const supplierMatchedDescriptive = matchedSupplierIds.map((supplierId) => {
      const first = leftRuns.filter((run) => run.supplierId === supplierId);
      const second = rightRuns.filter((run) => run.supplierId === supplierId);
      const mean = (selected: typeof runs, field: (run: (typeof runs)[number]) => number | null) =>
        statistics(selected.map(field)).mean;
      return {
        supplierId,
        leftRunCount: first.length,
        rightRunCount: second.length,
        extractionAccuracyDifference: difference(
          mean(first, (run) => run.extraction.combinedAccuracy.ratio),
          mean(second, (run) => run.extraction.combinedAccuracy.ratio),
        ),
        complianceF1Difference: difference(
          mean(first, (run) => run.compliance.counts.f1),
          mean(second, (run) => run.compliance.counts.f1),
        ),
        endToEndLatencyMsDifference: difference(
          mean(first, (run) => run.latency.endToEndMs),
          mean(second, (run) => run.latency.endToEndMs),
        ),
        totalEstimatedNovaUsdDifference: difference(
          mean(first, (run) => run.cost.totalEstimatedNovaUsd),
          mean(second, (run) => run.cost.totalEstimatedNovaUsd),
        ),
      };
    });
    return {
      left: { modelId: left.modelId, mode: left.mode },
      right: { modelId: right.modelId, mode: right.mode },
      available: left.runCount > 0 && right.runCount > 0,
      sameSupplierCoverage: left.supplierIds.join("|") === right.supplierIds.join("|"),
      matchedSupplierIds,
      supplierMatchedDescriptive,
      pairedObservationCount: paired.length,
      paired,
      pairedExtractionAccuracyDifference: statistics(
        paired.map((pair) => pair.extractionAccuracyDifference),
      ),
      incomplete:
        left.runCount === 0 ||
        right.runCount === 0 ||
        matchedSupplierIds.length === 0 ||
        left.supplierIds.join("|") !== right.supplierIds.join("|") ||
        paired.length !== leftRuns.length ||
        paired.length !== rightRuns.length,
    };
  });
  return {
    experimentId,
    runs,
    configurations,
    comparisons,
    missingConfigurations: configurations
      .filter((config) => config.runCount === 0)
      .map((config) => ({ modelId: config.modelId, mode: config.mode })),
    limitations: [
      ...configurations
        .filter((config) => config.runCount === 1)
        .map((config) => `${config.modelId}/${config.mode}: one run cannot measure repeatability.`),
      ...configurations
        .filter(
          (config) =>
            config.runCount > 0 && config.distinctSupplierCount < reference.suppliers.length,
        )
        .map(
          (config) =>
            `${config.modelId}/${config.mode}: supplier coverage ${config.distinctSupplierCount}/${reference.suppliers.length}.`,
        ),
      "No significance testing; retrieval latency and Titan cost are not recorded in assessment reports.",
    ],
  };
}
