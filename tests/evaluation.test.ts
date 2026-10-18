import { describe, expect, it } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateAssessment } from "../packages/evaluation/src/evaluate.ts";
import { voltlineFacts } from "./fixtures.ts";

function report() {
  return {
    tender: { validation: { valid: true } },
    supplier: {
      documentId: "voltline",
      extracted: voltlineFacts(),
      validation: { valid: true },
    },
    assessment: {
      status: "requires_review",
      findings: [{ type: "conflicting_dates" }, { type: "missing_evidence" }],
    },
  };
}

describe("offline assessment evaluation", () => {
  it("accepts a qualification with its source year and labels references as count-only", () => {
    const result = evaluateAssessment(report(), reference);
    expect(result.factualAccuracy.passed).toBe(result.factualAccuracy.total);
    expect(
      result.factualAccuracy.checks.find((check) => check.field === "supervisorQualification"),
    ).toMatchObject({
      actual: "Diploma of Electrical Engineering (2021)",
      matches: true,
    });
    const incorrectNames = report();
    incorrectNames.supplier.extracted.comparableReferences =
      incorrectNames.supplier.extracted.comparableReferences.map((entry, index) => ({
        ...entry,
        value: `Wrong project ${index + 1}`,
      }));
    const countOnly = evaluateAssessment(incorrectNames, reference);
    expect(
      countOnly.factualAccuracy.checks.find((check) => check.field === "comparableReferencesCount"),
    ).toMatchObject({ expected: 2, actual: 2, matches: true });
    expect(
      countOnly.factualAccuracy.checks.some((check) => check.field === "comparableReferences"),
    ).toBe(false);
  });

  it("requires review when citations fail even if factual values match", () => {
    const saved = report();
    saved.supplier.validation.valid = false;
    const result = evaluateAssessment(saved, reference);
    expect(result.factualAccuracy.passed).toBe(result.factualAccuracy.total);
    expect(result.citationValidity.supplierValid).toBe(false);
    expect(result.overallResult).toBe("requires_review");
  });

  it("keeps incorrect factual values and findings visible", () => {
    const saved = report();
    saved.supplier.extracted.priceExGst!.value = 1_000_000;
    saved.assessment.findings = [];
    const result = evaluateAssessment(saved, reference);
    expect(
      result.factualAccuracy.checks.find((check) => check.field === "priceExGstAud")?.matches,
    ).toBe(false);
    expect(result.complianceFindings.matches).toBe(false);
    expect(result.overallResult).toBe("requires_review");
  });
});
