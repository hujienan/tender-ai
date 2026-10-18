import type { SupplierFacts } from "../../extraction/src/schema.ts";

type Reference = {
  currency: string;
  suppliers: { id: string; name: string; documentId: string }[];
  answers: { subject: string; field: string; value: string | number }[];
  issues: { subject: string; type: string }[];
};

function scoreFacts(
  facts: SupplierFacts | null,
  supplier: Reference["suppliers"][number],
  reference: Reference,
) {
  const liability = facts?.insuranceEvidence.publicLiability?.value;
  const actualByField: Record<string, string | number | null> = {
    priceExGstAud: facts?.priceExGst?.value ?? null,
    durationWeeks: facts?.proposedDurationWeeks?.value ?? null,
    programmeCompletion: facts?.programmeCompletionDate?.value ?? null,
    commercialCompletion: facts?.commercialCompletionDate?.value ?? null,
    warrantyMonths: facts?.warranty?.value.months ?? null,
    contractorLicence: facts?.contractorLicence?.value ?? null,
    supervisorQualification: facts?.supervisorQualification?.value ?? null,
    comparableReferences: facts?.comparableReferences.length ?? null,
    publicLiabilityCertificate:
      liability?.status === "explicitly_missing"
        ? "not attached"
        : liability?.status === "attached"
          ? liability.policyId
          : null,
  };
  const answers = reference.answers.filter((answer) => answer.subject === supplier.id);
  const checks: {
    field: string;
    expected: string | number | null;
    actual: string | number | null;
  }[] = [
    { field: "supplierName", expected: supplier.name, actual: facts?.supplierName?.value ?? null },
    { field: "currency", expected: reference.currency, actual: facts?.currency?.value ?? null },
    ...answers.map((answer) => ({
      field: answer.field === "comparableReferences" ? "comparableReferencesCount" : answer.field,
      expected: answer.value,
      actual: actualByField[answer.field] ?? null,
    })),
  ];
  if (!answers.some((answer) => answer.field === "commercialCompletion")) {
    checks.push({
      field: "commercialCompletion",
      expected: null,
      actual: actualByField.commercialCompletion ?? null,
    });
  }
  return checks.map((check) => ({
    ...check,
    matches:
      check.field === "supervisorQualification" &&
      typeof check.expected === "string" &&
      typeof check.actual === "string"
        ? check.actual.replace(/\s+\(\d{4}\)$/, "") === check.expected
        : Object.is(check.expected, check.actual),
  }));
}

export function evaluateAssessment(
  report: {
    tender: { validation: { valid: boolean; fields?: Record<string, { status: string }> } };
    supplier: {
      documentId: string;
      extracted: SupplierFacts | null;
      validation: { valid: boolean; fields?: Record<string, { status: string }> };
    };
    assessment: { status: string; findings: { type: string }[] };
  },
  reference: Reference,
) {
  const supplier = reference.suppliers.find(
    (entry) => entry.documentId === report.supplier.documentId,
  );
  if (!supplier)
    throw new Error(`No reference supplier for document ${report.supplier.documentId}.`);
  const checks = scoreFacts(report.supplier.extracted, supplier, reference);
  const passed = checks.filter((check) => check.matches).length;
  const deterministicTypes = new Set(["late_completion", "missing_evidence", "conflicting_dates"]);
  const expected = reference.issues
    .filter((issue) => issue.subject === supplier.id && deterministicTypes.has(issue.type))
    .map((issue) => issue.type)
    .sort();
  const actual = report.assessment.findings.map((finding) => finding.type).sort();
  const findingMatches = JSON.stringify(expected) === JSON.stringify(actual);
  return {
    supplierId: supplier.id,
    factualAccuracy: { passed, total: checks.length, checks },
    complianceFindings: { expected, actual, matches: findingMatches },
    citationValidity: {
      tenderValid: report.tender.validation.valid,
      supplierValid: report.supplier.validation.valid,
      ...(report.tender.validation.fields ? { tenderFields: report.tender.validation.fields } : {}),
      ...(report.supplier.validation.fields
        ? { supplierFields: report.supplier.validation.fields }
        : {}),
    },
    unscoredReferenceIssues: reference.issues
      .filter((issue) => issue.subject === supplier.id && !deterministicTypes.has(issue.type))
      .map((issue) => issue.type),
    overallResult:
      passed === checks.length &&
      findingMatches &&
      report.tender.validation.valid &&
      report.supplier.validation.valid &&
      report.assessment.status === "assessed"
        ? "acceptable"
        : "requires_review",
  };
}
