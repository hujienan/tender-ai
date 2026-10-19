import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateAssessment } from "../packages/evaluation/src/evaluate.ts";
import { SupplierFactsSchema, type SupplierFacts } from "../packages/extraction/src/schema.ts";
import { tenderFacts, voltlineFacts } from "./fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
type Report = Parameters<typeof evaluateAssessment>[0];
type SupplierId = keyof typeof reference.expectedExtraction.suppliers;

function factsFor(id: SupplierId): SupplierFacts {
  const expected = reference.expectedExtraction.suppliers[id];
  const cite = (value: unknown) => ({
    value,
    evidence: [{ documentId: id, page: 1, quote: "Synthetic test quotation." }],
  });
  return SupplierFactsSchema.parse({
    supplierName: cite(expected.supplierName),
    priceExGst: cite(expected.priceExGst),
    currency: cite(expected.currency),
    proposedDurationWeeks: cite(expected.proposedDurationWeeks),
    warranty: cite(expected.warranty),
    programmeCompletionDate: cite(expected.programmeCompletionDate),
    commercialCompletionDate: expected.commercialCompletionDate
      ? cite(expected.commercialCompletionDate)
      : null,
    contractorLicence: cite(expected.contractorLicence),
    supervisorQualification: cite(expected.supervisorQualification),
    comparableReferences: expected.comparableReferences.map(cite),
    insuranceEvidence: {
      publicLiability: cite(expected.insuranceEvidence.publicLiability),
      workersCompensation: cite(expected.insuranceEvidence.workersCompensation),
    },
  });
}

function report(id: SupplierId = "voltline"): Report {
  return {
    tender: {
      extracted: structuredClone(tenderFacts),
      validation: { valid: true },
      groups: { general: { extracted: {} }, compliance: { extracted: {} } },
    },
    supplier: {
      documentId: id,
      extracted: id === "voltline" ? voltlineFacts() : factsFor(id),
      validation: { valid: true },
      recovery: { fieldErrors: {} },
    },
    assessment: {
      status: "requires_review",
      findings:
        id === "voltline"
          ? [{ type: "conflicting_dates" }, { type: "missing_evidence" }]
          : id === "arcwell"
            ? [{ type: "late_completion" }]
            : [],
    },
  };
}

const check = (
  result: ReturnType<typeof evaluateAssessment>,
  field: string,
  scope: "tender" | "supplier" = "supplier",
) =>
  (scope === "tender" ? result.tenderAccuracy : result.supplierAccuracy).checks.find(
    (entry) => entry.field === field,
  );

describe("offline assessment evaluation", () => {
  it("scores all tender and supplier leaves and accepts expected findings with human review", () => {
    const result = evaluateAssessment(report(), reference);
    expect(result.tenderAccuracy).toMatchObject({ passed: 8, total: 8, failed: [] });
    expect(result.supplierAccuracy).toMatchObject({ passed: 15, total: 15, failed: [] });
    expect(result.combinedAccuracy).toEqual({ passed: 23, total: 23, ratio: 1 });
    expect(result.complianceFindings.matches).toBe(true);
    expect(result.procurementReviewStatus).toBe("requires_review");
    expect(result.overallResult).toBe("acceptable");
    expect(check(result, "supervisorQualification")).toMatchObject({
      actual: "Diploma of Electrical Engineering (2021)",
      matches: true,
    });
    expect(check(result, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      expected: null,
      actual: null,
      matches: true,
    });
    const withoutYear = report();
    withoutYear.supplier.extracted!.supervisorQualification!.value =
      "Diploma of Electrical Engineering";
    expect(
      check(evaluateAssessment(withoutYear, reference), "supervisorQualification")?.matches,
    ).toBe(true);
    for (const id of ["sparrow", "arcwell"] as const) {
      const another = evaluateAssessment(report(id), reference);
      expect(another.tenderAccuracy).toMatchObject({ passed: 8, total: 8 });
      expect(another.supplierAccuracy).toMatchObject({ passed: 15, total: 15 });
      expect(another.overallResult).toBe("acceptable");
    }
  });

  it("accepts an omitted qualification year but rejects conflicting explicit years", () => {
    const saved = report();
    saved.supplier.extracted!.supervisorQualification!.value =
      "Diploma of Electrical Engineering (2099)";
    expect(check(evaluateAssessment(saved, reference), "supervisorQualification")).toMatchObject({
      expected: "Diploma of Electrical Engineering (2021)",
      actual: "Diploma of Electrical Engineering (2099)",
      matches: false,
      failureType: "wrong_value",
    });
  });

  it.each(["publicLiability", "workersCompensation"] as const)(
    "scores both %s fields when the expected insurance object is null",
    (insuranceType) => {
      const absentReference = structuredClone(reference) as unknown as typeof reference;
      (
        absentReference.expectedExtraction.suppliers.voltline.insuranceEvidence as Record<
          string,
          unknown
        >
      )[insuranceType] = null;
      const saved = report();
      saved.supplier.extracted!.insuranceEvidence[insuranceType] = null;
      const result = evaluateAssessment(saved, absentReference);
      expect(result.supplierAccuracy).toMatchObject({ passed: 15, total: 15 });
      expect(result.combinedAccuracy.total).toBe(23);
      for (const field of ["status", "policyId"]) {
        expect(check(result, `insuranceEvidence.${insuranceType}.${field}`)).toMatchObject({
          expected: null,
          actual: null,
          matches: true,
        });
      }
      expect(check(result, `insuranceEvidence.${insuranceType}`)).toBeUndefined();
    },
  );

  it("scores an unexpected insurance status separately from its absent policy ID", () => {
    const absentReference = structuredClone(reference) as unknown as typeof reference;
    (
      absentReference.expectedExtraction.suppliers.voltline.insuranceEvidence as Record<
        string,
        unknown
      >
    ).publicLiability = null;
    const result = evaluateAssessment(report(), absentReference);
    expect(result.supplierAccuracy.total).toBe(15);
    expect(check(result, "insuranceEvidence.publicLiability.status")).toMatchObject({
      expected: null,
      actual: "explicitly_missing",
      matches: false,
      failureType: "unexpected_value",
    });
    expect(check(result, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      expected: null,
      actual: null,
      matches: true,
    });
  });

  it("separates missed tender dates from unresolved structural recovery", () => {
    const saved = report();
    saved.tender.extracted!.siteAccessDate = null;
    saved.tender.extracted!.requiredPracticalCompletionDate = null;
    saved.tender.groups!.general.recovery = {
      fieldErrors: {
        siteAccessDate: ["siteAccessDate: no structurally valid response value was recovered."],
      },
    };
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "siteAccessDate", "tender")).toMatchObject({
      expected: "2027-01-11",
      actual: null,
      matches: false,
      failureType: "structural_failure",
    });
    expect(check(result, "requiredPracticalCompletionDate", "tender")).toMatchObject({
      expected: "2027-05-28",
      actual: null,
      matches: false,
      failureType: "missed_fact",
    });
    expect(result.tenderAccuracy).toMatchObject({ passed: 6, total: 8 });
  });

  it("scores an invented policy ID separately from a correct certificate status", () => {
    const saved = report();
    saved.supplier.extracted!.insuranceEvidence.publicLiability!.value.policyId = "AUD 20 million";
    saved.supplier.validation.valid = false;
    saved.supplier.validation.fields = {
      "insuranceEvidence.publicLiability.status": { status: "valid" },
      "insuranceEvidence.publicLiability.policyId": { status: "invalid" },
    };
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "insuranceEvidence.publicLiability.status")).toMatchObject({
      matches: true,
      evidenceStatus: "valid",
    });
    expect(check(result, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      expected: null,
      actual: "AUD 20 million",
      matches: false,
      failureType: "unexpected_value",
      evidenceStatus: "invalid",
    });
    expect(result.citationValidity.supplierValid).toBe(false);
    expect(result.overallResult).toBe("requires_review");
  });

  it("distinguishes explicit null, missed fact, invented value, and missing reference entries", () => {
    const sparrow = report("sparrow");
    const correct = evaluateAssessment(sparrow, reference);
    expect(check(correct, "commercialCompletionDate")).toMatchObject({
      expected: null,
      actual: null,
      matches: true,
    });
    expect(check(correct, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      expected: "SYN-PL-202",
      matches: true,
    });
    sparrow.supplier.extracted!.insuranceEvidence.publicLiability!.value.policyId = null;
    sparrow.supplier.extracted!.commercialCompletionDate = {
      value: "2027-05-04",
      evidence: [],
    };
    const changed = evaluateAssessment(sparrow, reference);
    expect(check(changed, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      failureType: "missed_fact",
    });
    expect(check(changed, "commercialCompletionDate")).toMatchObject({
      failureType: "unexpected_value",
    });
    const incomplete = structuredClone(reference) as unknown as typeof reference;
    delete (
      incomplete.expectedExtraction.suppliers.voltline.insuranceEvidence.publicLiability as Record<
        string,
        unknown
      >
    ).policyId;
    expect(() => evaluateAssessment(report(), incomplete)).toThrow(/Reference voltline/);
    const mistyped = structuredClone(reference) as unknown as typeof reference;
    (mistyped.expectedExtraction.tender as Record<string, unknown>).siteAccessDate = 123;
    expect(() => evaluateAssessment(report(), mistyped)).toThrow(/invalid or missing value/);
  });

  it("compares warranty children and both insurance categories independently", () => {
    const saved = report("arcwell");
    saved.supplier.extracted!.warranty!.value.conditions = "after commissioning";
    saved.supplier.extracted!.insuranceEvidence.workersCompensation!.value.policyId = null;
    saved.supplier.extracted!.insuranceEvidence.publicLiability!.value.status = "claimed_only";
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "warranty.months")?.matches).toBe(true);
    expect(check(result, "warranty.conditions")?.matches).toBe(false);
    expect(check(result, "insuranceEvidence.workersCompensation.status")?.matches).toBe(true);
    expect(check(result, "insuranceEvidence.workersCompensation.policyId")?.matches).toBe(false);
    expect(check(result, "insuranceEvidence.publicLiability.status")?.matches).toBe(false);
    expect(check(result, "insuranceEvidence.publicLiability.policyId")?.matches).toBe(true);
  });

  it("compares numeric and Boolean values exactly", () => {
    const saved = report();
    saved.supplier.extracted!.priceExGst!.value = 1_184_001;
    saved.tender.extracted!.publicLiabilityCertificateRequired!.value = false;
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "priceExGst")?.matches).toBe(false);
    expect(check(result, "publicLiabilityCertificateRequired", "tender")?.matches).toBe(false);
  });

  it("compares reference identities without depending on order", () => {
    const saved = report();
    saved.supplier.extracted!.comparableReferences.reverse();
    expect(check(evaluateAssessment(saved, reference), "comparableReferences")?.matches).toBe(true);
    saved.supplier.extracted!.comparableReferences[0]!.value = "Wrong project (2025)";
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "comparableReferences")).toMatchObject({
      matches: false,
      failureType: "wrong_value",
    });
  });

  it("keeps value accuracy independent of invalid evidence", () => {
    const saved = report();
    saved.supplier.validation.valid = false;
    saved.supplier.validation.fields = {
      priceExGst: { status: "invalid", errors: ["Wrong page."] },
    };
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "priceExGst")).toMatchObject({
      matches: true,
      valueMatches: true,
      evidenceStatus: "invalid",
    });
    expect(result.overallResult).toBe("requires_review");
    saved.supplier.extracted!.priceExGst!.value = 1_000_000;
    saved.assessment.findings = [];
    const incorrect = evaluateAssessment(saved, reference);
    expect(check(incorrect, "priceExGst")).toMatchObject({
      matches: false,
      evidenceStatus: "invalid",
    });
    expect(incorrect.complianceFindings.matches).toBe(false);
  });

  it("does not count an unresolved placeholder null as a correct absence", () => {
    const saved = report("sparrow");
    saved.supplier.recovery = {
      fieldErrors: {
        commercialCompletionDate: [
          "commercialCompletionDate: no structurally valid response value was recovered.",
        ],
      },
    };
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "commercialCompletionDate")).toMatchObject({
      expected: null,
      actual: null,
      valueMatches: true,
      matches: false,
      failureType: "structural_failure",
    });
  });

  it("labels legacy nulls without recovery provenance as unverifiable", () => {
    const saved = report();
    saved.supplier.recovery = undefined;
    const result = evaluateAssessment(saved, reference);
    expect(check(result, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      expected: null,
      actual: null,
      valueMatches: true,
      matches: false,
      failureType: "unverifiable_absence",
    });
    expect(result.provenanceLimitations).toHaveLength(1);
    expect(result.overallResult).toBe("requires_review");
  });

  it("accepts schemaVersion 1 file and stdin input through the offline CLI", () => {
    const script = join(root, "scripts/evaluate.ts");
    const fixture = join(root, "tests/fixtures/evaluation-report.json");
    for (const [argument, input] of [
      [fixture, undefined],
      [
        "-",
        JSON.stringify({
          schemaVersion: 1,
          ...report(),
          mode: "rag",
        }),
      ],
    ] as const) {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", script, argument], {
        input,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).combinedAccuracy.total).toBe(23);
    }
  });
});
