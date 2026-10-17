import type { Evidence, SupplierFacts, TenderRequirements } from "../../extraction/src/schema.ts";

type Validated<T> = {
  extracted: T | null;
  validation: { valid: boolean; errors: string[] };
};

export type ComplianceFinding = {
  type: "late_completion" | "missing_evidence" | "conflicting_dates";
  description: string;
  evidence: Evidence[];
};

// Future AI or human review may assess these topics; they are not automatic compliance findings.
export type ReviewCandidate = {
  topic: "warranty_terms" | "qualification_validity";
  question: string;
  evidence: Evidence[];
};

export function compareCompliance(
  tender: Validated<TenderRequirements>,
  supplier: Validated<SupplierFacts>,
) {
  const findings: ComplianceFinding[] = [];
  const reviewReasons: string[] = [];
  const reviewCandidates: ReviewCandidate[] = [];
  if (!tender.validation.valid || !tender.extracted) {
    reviewReasons.push("Tender requirements are unavailable or have invalid evidence.");
  }
  if (!supplier.validation.valid || !supplier.extracted) {
    reviewReasons.push("Supplier facts are unavailable or have invalid evidence.");
  }
  if (!tender.extracted || !supplier.extracted || reviewReasons.length) {
    return { status: "requires_review" as const, findings, reviewReasons, reviewCandidates };
  }

  const requirements = tender.extracted;
  const facts = supplier.extracted;
  const deadline = requirements.requiredPracticalCompletionDate;
  const programme = facts.programmeCompletionDate;
  const commercial = facts.commercialCompletionDate;
  if (!deadline || !programme) {
    reviewReasons.push("Required or proposed practical completion date is missing.");
  } else if (programme.value > deadline.value) {
    findings.push({
      type: "late_completion",
      description: "Proposed practical completion is after the required date.",
      evidence: [...deadline.evidence, ...programme.evidence],
    });
  }
  if (programme && commercial && programme.value !== commercial.value) {
    findings.push({
      type: "conflicting_dates",
      description: "Programme and commercial completion dates conflict.",
      evidence: [...programme.evidence, ...commercial.evidence],
    });
  }

  for (const [kind, required, insurance] of [
    [
      "public liability",
      requirements.publicLiabilityCertificateRequired,
      facts.insuranceEvidence.publicLiability,
    ],
    [
      "workers compensation",
      requirements.workersCompensationCertificateRequired,
      facts.insuranceEvidence.workersCompensation,
    ],
  ] as const) {
    if (!required) {
      reviewReasons.push(`Tender requirement for ${kind} insurance is missing.`);
    } else if (required.value && !insurance) {
      reviewReasons.push(`Supplier ${kind} insurance evidence is missing from the extraction.`);
    } else if (required.value && insurance?.value.status === "explicitly_missing") {
      findings.push({
        type: "missing_evidence",
        description: `Mandatory ${kind} insurance certificate is explicitly missing.`,
        evidence: [...required.evidence, ...insurance.evidence],
      });
    } else if (required.value && insurance?.value.status === "claimed_only") {
      reviewReasons.push(`Supplier ${kind} certificate is claimed but not verified as attached.`);
    }
  }

  if (facts.warranty?.value.conditions) {
    reviewCandidates.push({
      topic: "warranty_terms",
      question: "Review warranty scope, start date and exclusions.",
      evidence: facts.warranty.evidence,
    });
  }
  if (facts.supervisorQualification) {
    reviewCandidates.push({
      topic: "qualification_validity",
      question: "Verify current supervisor qualifications; an award year is not an expiry date.",
      evidence: facts.supervisorQualification.evidence,
    });
  }
  return {
    status:
      reviewReasons.length || findings.length || reviewCandidates.length
        ? ("requires_review" as const)
        : ("assessed" as const),
    findings,
    reviewReasons,
    reviewCandidates,
  };
}
