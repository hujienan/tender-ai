import { z } from "zod";

export const SUPPORTED_FINDING_TYPES = [
  "late_completion",
  "missing_evidence",
  "conflicting_dates",
] as const;
type FindingType = (typeof SUPPORTED_FINDING_TYPES)[number];
export type Counts = { tp: number; fp: number; fn: number; tn: number };
type Reference = {
  suppliers: { id: string; documentId: string }[];
  issues: { id?: string; subject: string; type: string }[];
};

const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["full", "rag"]).optional(),
    tender: z.object({ validation: z.object({ valid: z.boolean() }).optional() }).passthrough(),
    supplier: z
      .object({
        documentId: z.string().min(1),
        validation: z.object({ valid: z.boolean() }).optional(),
      })
      .passthrough(),
    assessment: z
      .object({
        status: z.string(),
        findings: z.array(z.object({ type: z.string().min(1) }).passthrough()),
        reviewCandidates: z.array(z.object({ topic: z.string() }).passthrough()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function metrics({ tp, fp, fn, tn }: Counts) {
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall
        ? (2 * precision * recall) / (precision + recall)
        : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

export function sumCounts(values: readonly Counts[]): Counts {
  return values.reduce(
    (total, value) => ({
      tp: total.tp + value.tp,
      fp: total.fp + value.fp,
      fn: total.fn + value.fn,
      tn: total.tn + value.tn,
    }),
    { tp: 0, fp: 0, fn: 0, tn: 0 },
  );
}

export function evaluateCompliance(savedReports: readonly unknown[], reference: Reference) {
  if (savedReports.length === 0)
    throw new Error("At least one saved assessment report is required.");
  const suppliers = new Map(reference.suppliers.map((entry) => [entry.documentId, entry]));
  if (
    suppliers.size !== reference.suppliers.length ||
    new Set(reference.suppliers.map((entry) => entry.id)).size !== reference.suppliers.length
  ) {
    throw new Error("Reference supplier IDs must be unique.");
  }
  const seen = new Set<string>();
  const perSupplier = savedReports.map((saved) => {
    const report = reportSchema.parse(saved);
    const supplier = suppliers.get(report.supplier.documentId);
    if (!supplier) throw new Error(`Unknown reference supplier: ${report.supplier.documentId}.`);
    if (seen.has(supplier.id)) {
      throw new Error(
        `Duplicate report for supplier ${supplier.id}; evaluate each experiment separately.`,
      );
    }
    seen.add(supplier.id);

    const issues = reference.issues.filter((issue) => issue.subject === supplier.id);
    const expected = new Set(
      issues
        .map((issue) => issue.type)
        .filter((type): type is FindingType =>
          (SUPPORTED_FINDING_TYPES as readonly string[]).includes(type),
        ),
    );
    const actualFindings = report.assessment.findings.map((finding) => finding.type);
    const frequencies = new Map<string, number>();
    for (const type of actualFindings) frequencies.set(type, (frequencies.get(type) ?? 0) + 1);
    const actual = new Set(
      [...frequencies.keys()].filter((type): type is FindingType =>
        (SUPPORTED_FINDING_TYPES as readonly string[]).includes(type),
      ),
    );
    const predictionIssues = [
      ...[...frequencies]
        .filter(([, count]) => count > 1)
        .map(([type, count]) => ({
          type,
          reason: "duplicate" as const,
          count,
        })),
      ...[...frequencies]
        .filter(([type]) => !SUPPORTED_FINDING_TYPES.includes(type as FindingType))
        .map(([type, count]) => ({
          type,
          reason: "unsupported_type" as const,
          count,
        })),
    ];
    const byType = Object.fromEntries(
      SUPPORTED_FINDING_TYPES.map((type) => {
        const isExpected = expected.has(type);
        const isActual = actual.has(type);
        return [
          type,
          metrics({
            tp: Number(isExpected && isActual),
            fp: Number(!isExpected && isActual),
            fn: Number(isExpected && !isActual),
            tn: Number(!isExpected && !isActual),
          }),
        ];
      }),
    ) as Record<FindingType, ReturnType<typeof metrics>>;
    return {
      supplierId: supplier.id,
      documentId: supplier.documentId,
      mode: report.mode ?? null,
      expectedFindings: [...expected].sort(),
      actualFindings,
      supportedActualFindings: [...actual].sort(),
      counts: metrics(sumCounts(Object.values(byType))),
      byType,
      predictionIssues,
      predictionValid: predictionIssues.length === 0,
      unscoredReferenceIssues: issues
        .filter((issue) => !SUPPORTED_FINDING_TYPES.includes(issue.type as FindingType))
        .map((issue) => ({ id: issue.id ?? null, type: issue.type })),
      reviewCandidates:
        report.assessment.reviewCandidates?.map((candidate) => candidate.topic) ?? [],
      assessmentStatus: report.assessment.status,
      savedValidation: {
        tenderValid: report.tender.validation?.valid ?? null,
        supplierValid: report.supplier.validation?.valid ?? null,
        findingEvidenceIndependentlyChecked: false,
      },
    };
  });
  perSupplier.sort(
    (left, right) =>
      reference.suppliers.findIndex((entry) => entry.id === left.supplierId) -
      reference.suppliers.findIndex((entry) => entry.id === right.supplierId),
  );
  const perType = Object.fromEntries(
    SUPPORTED_FINDING_TYPES.map((type) => [
      type,
      metrics(sumCounts(perSupplier.map((supplier) => supplier.byType[type]))),
    ]),
  ) as Record<FindingType, ReturnType<typeof metrics>>;
  return {
    evaluationUnit: "supplier_id_and_supported_finding_type",
    supportedFindingTypes: SUPPORTED_FINDING_TYPES,
    scope: perSupplier.length === 1 ? "single_supplier" : "multiple_suppliers",
    supplierCoverage: {
      evaluated: perSupplier.length,
      available: reference.suppliers.length,
      complete: perSupplier.length === reference.suppliers.length,
    },
    perSupplier,
    perType,
    micro: metrics(sumCounts(perSupplier.map((supplier) => supplier.counts))),
    predictionValid: perSupplier.every((supplier) => supplier.predictionValid),
  };
}
