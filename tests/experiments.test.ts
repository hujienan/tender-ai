import { spawnSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import retrievalReference from "../datasets/electrical-installation/retrieval-reference.json" with { type: "json" };
import { BEDROCK_MODEL_ID, NOVA_PRO_MODEL_ID } from "../packages/bedrock/src/client.ts";
import { evaluateExperiments } from "../packages/evaluation/src/experiments.ts";
import { extractPdf, type ExtractedPdf } from "../packages/pdf/src/extract.ts";
import { tenderFacts, voltlineFacts } from "./fixtures.ts";
import retrievalFixture from "./fixtures/retrieval-report.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
let sources: { tender: ExtractedPdf; suppliers: Record<string, ExtractedPdf> };
beforeAll(async () => {
  const tender = await extractPdf(
    join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
    "tender",
  );
  const suppliers = Object.fromEntries(
    await Promise.all(
      reference.suppliers.map(
        async (supplier) =>
          [
            supplier.documentId,
            await extractPdf(
              join(
                root,
                "datasets/electrical-installation/pdfs",
                `${supplier.documentId}-proposal.pdf`,
              ),
              supplier.documentId,
            ),
          ] as const,
      ),
    ),
  );
  sources = { tender, suppliers };
});

function attempt(modelId = BEDROCK_MODEL_ID) {
  return {
    modelId,
    region: "ap-southeast-2",
    serviceTier: "default",
    latencyMs: 100,
    tokenUsage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    costEstimate: { estimatedUsd: 0.01 },
    rawResponse: {},
    error: null as string | null,
  };
}

function report(
  mode: "full" | "rag" = "full",
  modelId = BEDROCK_MODEL_ID,
  supplierId = "voltline",
) {
  const general = attempt(modelId);
  const compliance = attempt(modelId);
  const supplier = attempt(modelId);
  return {
    schemaVersion: 1,
    mode,
    tender: {
      documentId: "tender",
      extracted: tenderFacts,
      validation: { valid: true, errors: [] as string[] },
      groups: {
        general: {
          extracted: tenderFacts,
          attempts: [general],
          recovery: { retried: false, unresolvedFields: [] as string[] },
        },
        compliance: {
          extracted: tenderFacts,
          attempts: [compliance],
          recovery: { retried: false, unresolvedFields: [] as string[] },
        },
      },
      attempts: [general, compliance],
    },
    supplier: {
      documentId: supplierId,
      extracted: supplierId === "voltline" ? voltlineFacts() : null,
      validation: { valid: true, errors: [] as string[] },
      attempts: [supplier],
      recovery: { retried: false, unresolvedFields: [] as string[] },
    },
    assessment: {
      status: "requires_review",
      findings:
        supplierId === "voltline"
          ? [{ type: "conflicting_dates" }, { type: "missing_evidence" }]
          : [],
      reviewCandidates: [{ topic: "warranty_terms" }],
    },
    knownEstimatedCostUsd: 0.03,
    totalEstimatedCostUsd: 0.03 as number | null,
    endToEndLatencyMs: 500,
    ...(mode === "rag" ? { retrieval: retrievalFixture.retrieval } : {}),
  };
}

const entry = (runId: string, saved: unknown, pairId?: string) => ({
  runId,
  report: saved,
  pairId,
});
const evaluate = (entries: Parameters<typeof evaluateExperiments>[1]) =>
  evaluateExperiments("synthetic-repetitions", entries, reference, retrievalReference, sources);

describe("offline repeated experiment evaluation", () => {
  it("reuses extraction, compliance and RAG retrieval scores without counting group attempts twice", () => {
    const result = evaluate([entry("full", report()), entry("rag", report("rag"))]);
    expect(result.runs[0]?.extraction.combinedAccuracy).toMatchObject({ passed: 23, total: 23 });
    expect(result.runs[0]?.compliance.counts).toMatchObject({ tp: 2, fp: 0, fn: 0, tn: 1 });
    expect(result.runs[0]?.retrieval).toEqual({ applicability: "not_applicable" });
    expect(result.runs[1]?.retrieval).toMatchObject({
      applicability: "evaluated",
      overallCoverage: { covered: 22, total: 22, ratio: 1 },
    });
    expect(result.runs[0]?.reliability.modelInvocations).toBe(3);
    expect(result.runs[0]?.reliability.tenderAttemptProvenance).toBe("verified");
    expect(result.runs[0]?.tokens).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      totalTokens: 360,
      observedAttempts: 3,
      complete: true,
    });
    expect(result.runs[0]?.latency).toMatchObject({
      endToEndMs: 500,
      totalModelInvocationMs: 300,
      retrievalMs: null,
      retrievalLatencyStatus: "not_applicable",
    });
    expect(result.runs[1]?.cost).toMatchObject({ totalEstimatedNovaUsd: 0.03, titanCostUsd: null });
    expect(result.missingConfigurations).toHaveLength(2);
    expect(result.configurations[0]?.runCount).toBe(1);
    expect(result.configurations[0]?.extractionAccuracy.sampleStandardDeviation).toBeNull();
  });

  it("aggregates repeated runs with sample standard deviation and supplier counts", () => {
    const bad = report();
    bad.tender.extracted = null as never;
    bad.supplier.extracted = null;
    bad.assessment.findings = [{ type: "late_completion" }];
    const result = evaluate([entry("good", report()), entry("bad", bad)]);
    const group = result.configurations[0]!;
    expect(group.runCount).toBe(2);
    expect(group.distinctSupplierCount).toBe(1);
    expect(group.extractionAccuracy).toMatchObject({
      available: 2,
      mean: 0.5,
      min: 0,
      max: 1,
      sampleStandardDeviation: Math.sqrt(0.5),
    });
    expect(group.compliance).toMatchObject({
      tp: 2,
      fp: 1,
      fn: 2,
      tn: 1,
      precision: 2 / 3,
      recall: 0.5,
    });
    expect(group.compliance.f1).toBeCloseTo(4 / 7);
    expect(group.endToEndLatencyMs).toMatchObject({ available: 2, mean: 500 });
  });

  it("keeps missing latency, usage and unpriced costs distinct from zero", () => {
    const saved = report();
    delete (saved as { endToEndLatencyMs?: number }).endToEndLatencyMs;
    delete (saved.tender.attempts[0] as { latencyMs?: number }).latencyMs;
    saved.supplier.attempts[0]!.tokenUsage = null as never;
    saved.supplier.attempts[0]!.costEstimate = null as never;
    saved.knownEstimatedCostUsd = 0.02;
    saved.totalEstimatedCostUsd = null;
    const result = evaluate([entry("partial", saved)]);
    const run = result.runs[0]!;
    expect(run.latency).toMatchObject({
      endToEndMs: null,
      totalModelInvocationMs: null,
      recordedModelInvocationMs: 200,
      timedInvocations: 2,
    });
    expect(run.tokens).toMatchObject({ observedAttempts: 2, complete: false, totalTokens: 240 });
    expect(run.cost).toMatchObject({
      knownEstimatedNovaUsd: 0.02,
      totalEstimatedNovaUsd: null,
      pricedInvocations: 2,
    });
    expect(result.configurations[0]?.endToEndLatencyMs).toMatchObject({
      available: 0,
      mean: null,
      sampleStandardDeviation: null,
    });
    expect(result.configurations[0]?.totalEstimatedNovaUsd.available).toBe(0);

    const unpriced = report();
    for (const item of [...unpriced.tender.attempts, ...unpriced.supplier.attempts])
      item.costEstimate = null as never;
    unpriced.knownEstimatedCostUsd = 0;
    unpriced.totalEstimatedCostUsd = null;
    const noPrice = evaluate([entry("unpriced", unpriced)]);
    expect(noPrice.runs[0]?.cost).toMatchObject({
      knownEstimatedNovaUsd: null,
      totalEstimatedNovaUsd: null,
      pricedInvocations: 0,
    });
    expect(noPrice.configurations[0]?.knownEstimatedNovaUsd.available).toBe(0);
  });

  it("retains unavailable invocation and recovery measurements for sparse older reports", () => {
    const sparse = report() as ReturnType<typeof report> & { modelId?: string };
    sparse.modelId = BEDROCK_MODEL_ID;
    delete (sparse.tender as { attempts?: unknown }).attempts;
    delete (sparse.supplier as { attempts?: unknown }).attempts;
    delete (sparse.tender as { groups?: unknown }).groups;
    delete (sparse.supplier as { recovery?: unknown }).recovery;
    delete (sparse as { endToEndLatencyMs?: number }).endToEndLatencyMs;
    const result = evaluate([entry("sparse", sparse)]);
    expect(result.runs[0]?.reliability).toMatchObject({
      modelInvocations: null,
      retried: null,
      invocationFailures: null,
    });
    expect(result.runs[0]?.tokens).toBeNull();
    expect(result.runs[0]?.latency).toMatchObject({
      endToEndMs: null,
      totalModelInvocationMs: null,
    });
    expect(result.configurations[0]?.recoveryFrequency.available).toBe(0);
  });

  it("rejects contradictory tender attempt histories and partial group metadata", () => {
    const inconsistent = report();
    inconsistent.tender.groups.general.attempts[0] = {
      ...inconsistent.tender.groups.general.attempts[0]!,
      latencyMs: 999,
    };
    expect(() => evaluate([entry("inconsistent", inconsistent)])).toThrow(
      /attempt history contradicts/,
    );

    const incomplete = report();
    delete (incomplete.tender.groups.compliance as { attempts?: unknown }).attempts;
    expect(() => evaluate([entry("incomplete", incomplete)])).toThrow(
      /incomplete tender group attempt metadata/,
    );

    const withoutGroups = report();
    delete (withoutGroups.tender as { groups?: unknown }).groups;
    expect(
      evaluate([entry("older", withoutGroups)]).runs[0]?.reliability.tenderAttemptProvenance,
    ).toBe("unavailable");

    const withoutParent = report();
    delete (withoutParent.tender as { attempts?: unknown }).attempts;
    delete (withoutParent.supplier as { attempts?: unknown }).attempts;
    expect(evaluate([entry("parent-absent", withoutParent)]).runs[0]?.reliability).toMatchObject({
      modelInvocations: null,
      tenderAttemptProvenance: "unavailable",
    });
  });

  it("rejects identical report contents as separate runs", () => {
    expect(() => evaluate([entry("first", report()), entry("second", report())])).toThrow(
      /report contents duplicate run first/,
    );
  });

  it("counts retries once and separates invalid responses from invocation failures", () => {
    const saved = report();
    const first = saved.tender.attempts[0]!;
    first.error = "Incomplete structured response";
    const retry = attempt();
    saved.tender.attempts.splice(1, 0, retry);
    saved.tender.groups.general.attempts.push(retry);
    saved.tender.groups.general.recovery.retried = true;
    saved.tender.groups.general.recovery.unresolvedFields = ["siteAccessDate"];
    saved.knownEstimatedCostUsd = 0.04;
    saved.totalEstimatedCostUsd = 0.04;
    const result = evaluate([entry("retry", saved)]);
    expect(result.runs[0]?.reliability).toMatchObject({
      modelInvocations: 4,
      retried: true,
      nonInvocationAttemptErrors: 1,
      invocationFailures: 0,
      unresolvedFields: ["siteAccessDate"],
    });
    expect(result.runs[0]?.tokens?.totalTokens).toBe(480);
    expect(result.runs[0]?.cost.totalEstimatedNovaUsd).toBe(0.04);
    expect(result.configurations[0]?.recoveryFrequency).toMatchObject({ available: 1, mean: 1 });
  });

  it("rejects invalid, unknown, missing and conflicting model identity", () => {
    expect(() => evaluate([entry("same", report()), entry("same", report())])).toThrow(/Duplicate/);
    expect(() => evaluate([entry("bad-schema", { ...report(), schemaVersion: 2 })])).toThrow();
    const missing = report();
    delete (missing.tender as { attempts?: unknown }).attempts;
    delete (missing.supplier as { attempts?: unknown }).attempts;
    delete (missing.tender as { groups?: unknown }).groups;
    expect(() => evaluate([entry("missing", missing)])).toThrow(/model metadata is missing/);
    const unknown = report("full", "unknown.model");
    expect(() => evaluate([entry("unknown", unknown)])).toThrow(/unsupported model ID/);
    const conflict = report();
    conflict.supplier.attempts[0]!.modelId = NOVA_PRO_MODEL_ID;
    expect(() => evaluate([entry("conflict", conflict)])).toThrow(/conflicting model identifiers/);
    expect(() => evaluate([{ ...entry("expectation", report()), expectedMode: "rag" }])).toThrow(
      /expected mode/,
    );
    expect(() =>
      evaluate([{ ...entry("expectation", report()), expectedSupplierId: "sparrow" }]),
    ).toThrow(/expected supplier/);
  });

  it("compares supplier-matched observations without inventing run pairs", () => {
    const rag = report("rag");
    rag.endToEndLatencyMs = 600;
    const paired = evaluate([entry("full", report(), "round-1"), entry("rag", rag, "round-1")]);
    const comparison = paired.comparisons[0]!;
    expect(comparison.matchedSupplierIds).toEqual(["voltline"]);
    expect(comparison.pairedObservationCount).toBe(1);
    expect(comparison.paired[0]).toMatchObject({
      leftRunId: "full",
      rightRunId: "rag",
      extractionAccuracyDifference: 0,
      endToEndLatencyMsDifference: 100,
    });
    expect(comparison.incomplete).toBe(false);
    const unpaired = evaluate([entry("full", report()), entry("rag", rag)]).comparisons[0]!;
    expect(unpaired.supplierMatchedDescriptive[0]?.extractionAccuracyDifference).toBe(0);
    expect(unpaired.pairedObservationCount).toBe(0);
    expect(unpaired.incomplete).toBe(true);
    const secondFull = report();
    secondFull.endToEndLatencyMs = 501;
    const partialPairs = evaluate([
      entry("full-a", report(), "round-1"),
      entry("full-b", secondFull),
      entry("rag", rag, "round-1"),
    ]).comparisons[0]!;
    expect(partialPairs.pairedObservationCount).toBe(1);
    expect(partialPairs.incomplete).toBe(true);
    expect(() => evaluate([entry("a", report(), "same"), entry("b", secondFull, "same")])).toThrow(
      /duplicate pair ID/,
    );
  });

  it("groups all four model and mode configurations without filename inference", () => {
    const result = evaluate([
      entry("lite-full", report()),
      entry("lite-rag", report("rag")),
      entry("pro-full", report("full", NOVA_PRO_MODEL_ID)),
      entry("pro-rag", report("rag", NOVA_PRO_MODEL_ID)),
    ]);
    expect(result.configurations.map((group) => group.runCount)).toEqual([1, 1, 1, 1]);
    expect(result.missingConfigurations).toEqual([]);
    expect(result.comparisons).toHaveLength(4);
    expect(result.runs[3]?.modelId).toBe(NOVA_PRO_MODEL_ID);
  });

  it("reports unequal supplier coverage and absent configurations", () => {
    const result = evaluate([
      entry("full-voltline", report()),
      entry("full-sparrow", report("full", BEDROCK_MODEL_ID, "sparrow")),
      entry("rag", report("rag")),
    ]);
    const comparison = result.comparisons[0]!;
    expect(comparison.sameSupplierCoverage).toBe(false);
    expect(comparison.matchedSupplierIds).toEqual(["voltline"]);
    expect(comparison.incomplete).toBe(true);
    expect(result.configurations[0]?.distinctSupplierCount).toBe(2);
    expect(result.missingConfigurations).toHaveLength(2);
  });

  it("loads relative report paths from a manifest and reports missing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tender-ai-experiment-"));
    await writeFile(join(directory, "saved.json"), JSON.stringify(report()));
    const manifest = {
      experimentId: "offline-fixture",
      runs: [{ runId: "first", report: "saved.json" }],
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const script = join(root, "scripts/evaluate-experiments.ts");
    const valid = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, join(directory, "manifest.json")],
      { encoding: "utf8" },
    );
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout).runs[0]).toMatchObject({
      runId: "first",
      modelId: BEDROCK_MODEL_ID,
      mode: "full",
    });
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, runs: [{ runId: "missing", report: "absent.json" }] }),
    );
    const absent = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, join(directory, "manifest.json")],
      { encoding: "utf8" },
    );
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toMatch(/cannot read report/);
  });

  it("rejects duplicate canonical paths, symlink aliases and copied report contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tender-ai-duplicate-"));
    const saved = JSON.stringify(report());
    await writeFile(join(directory, "saved.json"), saved);
    await writeFile(join(directory, "copy.json"), saved);
    await symlink(join(directory, "saved.json"), join(directory, "alias.json"));
    const manifestPath = join(directory, "manifest.json");
    const script = join(root, "scripts/evaluate-experiments.ts");
    const run = () => {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", script, manifestPath],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      return result.stderr;
    };
    for (const [second, error] of [
      ["./saved.json", /report path duplicates/],
      ["alias.json", /report path duplicates/],
      ["copy.json", /report contents duplicate/],
    ] as const) {
      await writeFile(
        manifestPath,
        JSON.stringify({
          experimentId: "duplicates",
          runs: [
            { runId: "first", report: "saved.json" },
            { runId: "second", report: second },
          ],
        }),
      );
      expect(run()).toMatch(error);
    }
  });
});
