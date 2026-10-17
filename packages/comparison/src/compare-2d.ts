import type { SupplierFacts, TenderRequirements } from "../../extraction/src/schema.ts";
import type { FieldValidation } from "../../extraction/src/field-validation.ts";
import type { ComplianceFinding, ReviewCandidate } from "./compare.ts";

type Report<T> = { extracted: T | null; validation: FieldValidation };

export function compareCompliance2D(
  tender: Report<TenderRequirements>,
  supplier: Report<SupplierFacts>,
) {
  const findings: ComplianceFinding[] = [];
  const reviewReasons: string[] = [];
  const reviewCandidates: ReviewCandidate[] = [];
  const verified = (report: Report<unknown>, field: string) =>
    report.validation.fields[field]?.status === "valid";

  for (const [label, report] of [
    ["Tender", tender],
    ["Supplier", supplier],
  ] as const) {
    const unresolved = Object.entries(report.validation.fields)
      .filter(
        ([field, check]) =>
          check.status === "invalid" && !field.startsWith("comparableReferences["),
      )
      .map(([field]) => field);
    if (unresolved.length) {
      reviewReasons.push(label + " has unverified fields: " + unresolved.join(", ") + ".");
    }
  }

  if (!tender.extracted || !supplier.extracted) {
    reviewReasons.push("Tender or supplier facts are unavailable.");
    return { status: "requires_review" as const, findings, reviewReasons, reviewCandidates };
  }

  const requirements = tender.extracted;
  const facts = supplier.extracted;
  const deadline = requirements.requiredPracticalCompletionDate;
  const programme = facts.programmeCompletionDate;
  const commercial = facts.commercialCompletionDate;

  const validDeadline = verified(tender, "requiredPracticalCompletionDate") && !!deadline;
  const validProgramme = verified(supplier, "programmeCompletionDate") && !!programme;
  if (!validDeadline || !validProgramme) {
    reviewReasons.push("Cannot evaluate completion deadline without validated dates.");
  } else if (deadline!.value < programme!.value) {
    findings.push({
      type: "late_completion",
      description: "Proposed practical completion is after the required date.",
      evidence: [...deadline!.evidence, ...programme!.evidence],
    });
  }

  if (validProgramme && verified(supplier, "commercialCompletionDate") && commercial) {
    if (programme!.value !== commercial.value) {
      findings.push({
        type: "conflicting_dates",
        description: "Programme and commercial completion dates conflict.",
        evidence: [...programme!.evidence, ...commercial.evidence],
      });
    }
  } else if (supplier.validation.fields.commercialCompletionDate?.status === "invalid") {
    reviewReasons.push("Commercial completion date is unverified.");
  }

  for (const [label, requiredField, kind] of [
    ["public liability", "publicLiabilityCertificateRequired", "publicLiability"],
    ["workers compensation", "workersCompensationCertificateRequired", "workersCompensation"],
  ] as const) {
    const required = requirements[requiredField];
    const insurance = facts.insuranceEvidence[kind];
    const statusKey = "insuranceEvidence." + kind + ".status";
    if (!verified(tender, requiredField) || !required) {
      reviewReasons.push("Tender " + label + " insurance requirement is unavailable.");
      continue;
    }
    if (!required.value) continue;
    if (!verified(supplier, statusKey) || !insurance) {
      reviewReasons.push("Supplier " + label + " certificate status is unverified or absent.");
      continue;
    }
    if (insurance.value.status === "explicitly_missing") {
      findings.push({
        type: "missing_evidence",
        description: "Mandatory " + label + " insurance certificate is explicitly missing.",
        evidence: [...required.evidence, ...insurance.evidence],
      });
    } else if (insurance.value.status === "claimed_only") {
      reviewReasons.push(
        "Supplier " + label + " certificate is claimed but not verified as attached.",
      );
    }
  }

  if (verified(supplier, "warranty") && facts.warranty?.value.conditions) {
    reviewCandidates.push({
      topic: "warranty_terms",
      question: "Review warranty scope, start date and exclusions.",
      evidence: facts.warranty.evidence,
    });
  }
  if (verified(supplier, "supervisorQualification") && facts.supervisorQualification) {
    reviewCandidates.push({
      topic: "qualification_validity",
      question: "Verify current supervisor qualifications; an award year is not an expiry date.",
      evidence: facts.supervisorQualification.evidence,
    });
  }

  return {
    status:
      reviewReasons.length || reviewCandidates.length || findings.length
        ? ("requires_review" as const)
        : ("assessed" as const),
    findings,
    reviewReasons,
    reviewCandidates,
  };
}
