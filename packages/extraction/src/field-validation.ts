import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { validateSupplierFacts, validateTenderRequirements } from "./evidence.ts";
import type { SupplierFacts, TenderRequirements } from "./schema.ts";

export type FieldCheck = {
  status: "valid" | "invalid" | "missing";
  errors: string[];
};
export type FieldValidation = {
  valid: boolean;
  errors: string[];
  fields: Record<string, FieldCheck>;
};

export function mergeFieldErrors(...sets: Record<string, string[]>[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const set of sets) {
    for (const [field, errors] of Object.entries(set)) {
      merged[field] = [...(merged[field] ?? []), ...errors];
    }
  }
  return merged;
}

export const TENDER_GENERAL_FIELDS = [
  "tenderId",
  "closingDate",
  "siteAccessDate",
  "requiredPracticalCompletionDate",
  "requiredCurrency",
] as const;
export const TENDER_COMPLIANCE_FIELDS = [
  "minimumComparableReferences",
  "publicLiabilityCertificateRequired",
  "workersCompensationCertificateRequired",
] as const;
export const TENDER_FIELDS = [...TENDER_GENERAL_FIELDS, ...TENDER_COMPLIANCE_FIELDS] as const;

export const SUPPLIER_FIELDS = [
  "supplierName",
  "priceExGst",
  "currency",
  "proposedDurationWeeks",
  "warranty",
  "programmeCompletionDate",
  "commercialCompletionDate",
  "contractorLicence",
  "supervisorQualification",
  "comparableReferences",
] as const;

export const EMPTY_TENDER: TenderRequirements = {
  tenderId: null,
  closingDate: null,
  siteAccessDate: null,
  requiredPracticalCompletionDate: null,
  requiredCurrency: null,
  minimumComparableReferences: null,
  publicLiabilityCertificateRequired: null,
  workersCompensationCertificateRequired: null,
};

function check(value: unknown, errors: string[]): FieldCheck {
  return {
    status: errors.length ? "invalid" : value == null ? "missing" : "valid",
    errors,
  };
}

export function validateTenderFields(
  facts: TenderRequirements,
  document: ExtractedPdf,
  unavailableGroups: Partial<Record<"general" | "compliance", string[]>> = {},
  fieldErrors: Record<string, string[]> = {},
): FieldValidation {
  const sourceErrors = validateTenderRequirements(facts, document).errors;
  const errors = [...sourceErrors, ...Object.values(fieldErrors).flat()];
  const fields: Record<string, FieldCheck> = {};
  for (const field of TENDER_FIELDS) {
    const group = (TENDER_GENERAL_FIELDS as readonly string[]).includes(field)
      ? "general"
      : "compliance";
    const groupErrors = unavailableGroups[group] ?? [];
    const matching = sourceErrors.filter(
      (error) =>
        error.startsWith("requirements." + field + ":") ||
        error.startsWith("requirements." + field + "."),
    );
    if (groupErrors.length) {
      const failures = groupErrors.map((error) => group + " extraction: " + error);
      fields[field] = { status: "invalid", errors: [...failures, ...matching] };
    } else {
      fields[field] = check(facts[field], [...matching, ...(fieldErrors[field] ?? [])]);
    }
  }
  for (const [group, groupErrors] of Object.entries(unavailableGroups)) {
    errors.push(...groupErrors.map((error) => group + " extraction: " + error));
  }
  return { valid: errors.length === 0, errors, fields };
}

export function validateSupplierFields(
  facts: SupplierFacts | null,
  document: ExtractedPdf,
  extractionErrors: string[] = [],
  fieldErrors: Record<string, string[]> = {},
): FieldValidation {
  const sourceErrors = facts ? validateSupplierFacts(facts, document).errors : [];
  const errors = [...extractionErrors, ...sourceErrors, ...Object.values(fieldErrors).flat()];
  const fields: Record<string, FieldCheck> = {};
  for (const field of SUPPLIER_FIELDS) {
    const matched = sourceErrors.filter(
      (error) =>
        error.startsWith("extraction." + field + ":") ||
        error.startsWith("extraction." + field + ".") ||
        error.startsWith("extraction." + field + "["),
    );
    const value = facts?.[field];
    fields[field] = facts
      ? check(value, [...matched, ...(fieldErrors[field] ?? [])])
      : { status: "invalid", errors: extractionErrors };
  }
  for (const kind of ["publicLiability", "workersCompensation"] as const) {
    const policy = facts?.insuranceEvidence[kind];
    const prefix = "extraction.insuranceEvidence." + kind;
    const citationErrors = sourceErrors.filter(
      (error) => error.startsWith(prefix + ".evidence") || error.startsWith(prefix + ":"),
    );
    const statusErrors = sourceErrors.filter((error) => error.startsWith(prefix + ".value.status"));
    const idErrors = sourceErrors.filter((error) => error.startsWith(prefix + ".value.policyId"));
    fields["insuranceEvidence." + kind + ".status"] = facts
      ? check(policy?.value.status, [
          ...citationErrors,
          ...statusErrors,
          ...(fieldErrors["insuranceEvidence." + kind + ".status"] ?? []),
        ])
      : { status: "invalid", errors: extractionErrors };
    fields["insuranceEvidence." + kind + ".policyId"] = facts
      ? check(policy?.value.policyId, [
          ...citationErrors,
          ...idErrors,
          ...(fieldErrors["insuranceEvidence." + kind + ".policyId"] ?? []),
        ])
      : { status: "invalid", errors: extractionErrors };
  }
  if (facts) {
    for (const [index, ref] of facts.comparableReferences.entries()) {
      const related = sourceErrors.filter((error) =>
        error.startsWith("extraction.comparableReferences[" + index + "]"),
      );
      fields["comparableReferences[" + index + "]"] = check(ref, [
        ...related,
        ...(fieldErrors["comparableReferences[" + index + "]"] ?? []),
      ]);
    }
  }
  return { valid: errors.length === 0, errors, fields };
}
