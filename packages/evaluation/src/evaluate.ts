import { z } from "zod";
import { TENDER_GENERAL_FIELDS } from "../../extraction/src/field-validation.ts";
import {
  SupplierFactsSchema,
  TenderRequirementsSchema,
  type SupplierFacts,
  type TenderRequirements,
} from "../../extraction/src/schema.ts";

type Reference = {
  suppliers: { id: string; documentId: string }[];
  expectedExtraction: { tender: unknown; suppliers: Record<string, unknown> };
  issues: { subject: string; type: string }[];
};
type Validation = {
  valid: boolean;
  fields?: Record<string, { status: string; errors?: string[] | undefined }> | undefined;
};
type Recovery = { fieldErrors?: Record<string, string[]> | undefined };
type Report = {
  tender: {
    extracted: TenderRequirements | null;
    validation: Validation;
    groups?:
      | {
          general: { extracted?: unknown; recovery?: Recovery | undefined };
          compliance: { extracted?: unknown; recovery?: Recovery | undefined };
        }
      | undefined;
  };
  supplier: {
    documentId: string;
    extracted: SupplierFacts | null;
    validation: Validation;
    recovery?: Recovery | undefined;
  };
  assessment: { status: string; findings: { type: string }[] };
};
type Check = {
  field: string;
  expected: unknown;
  actual: unknown;
  matches: boolean;
  valueMatches: boolean;
  evidenceStatus: string;
  failureType?:
    | "structural_failure"
    | "unresolved_recovery"
    | "unverifiable_absence"
    | "missed_fact"
    | "unexpected_value"
    | "wrong_value";
  actualPresence?: "omitted";
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const child = (value: unknown, key: string): unknown =>
  value === null ? null : isObject(value) ? value[key] : undefined;
const shape = (schema: z.ZodObject): Record<string, z.ZodType> =>
  schema.shape as Record<string, z.ZodType>;
const isCited = (schema: z.ZodObject) =>
  Object.hasOwn(schema.shape, "value") && Object.hasOwn(schema.shape, "evidence");

// Extraction schemas determine the scored leaves; reference key drift fails loudly.
function assertReference(schema: z.ZodType, value: unknown, path: string): void {
  if (schema instanceof z.ZodNullable) {
    if (value === null) return;
    assertReference(schema.unwrap() as z.ZodType, value, path);
  } else if (schema instanceof z.ZodObject) {
    if (isCited(schema)) {
      assertReference(shape(schema).value!, value, path);
      return;
    }
    if (!isObject(value)) throw new Error(`Reference ${path} must be an object.`);
    const keys = Object.keys(shape(schema));
    if (
      keys.length !== Object.keys(value).length ||
      keys.some((key) => !Object.hasOwn(value, key))
    ) {
      throw new Error(`Reference ${path} has missing or unsupported extraction fields.`);
    }
    for (const key of keys) assertReference(shape(schema)[key]!, value[key], `${path}.${key}`);
  } else if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) throw new Error(`Reference ${path} must be an array.`);
    value.forEach((item, index) =>
      assertReference(schema.element as z.ZodType, item, `${path}[${index}]`),
    );
  } else if (!schema.safeParse(value).success) {
    throw new Error(`Reference ${path} has an invalid or missing value.`);
  }
}

function project(schema: z.ZodType, value: unknown): unknown {
  if (value == null) return value;
  if (schema instanceof z.ZodNullable) return project(schema.unwrap() as z.ZodType, value);
  if (schema instanceof z.ZodArray)
    return Array.isArray(value)
      ? value.map((item) => project(schema.element as z.ZodType, item))
      : value;
  if (schema instanceof z.ZodObject) {
    if (isCited(schema)) return project(shape(schema).value!, child(value, "value"));
    return Object.fromEntries(
      Object.entries(shape(schema)).map(([key, member]) => [
        key,
        project(member, child(value, key)),
      ]),
    );
  }
  return value;
}

const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
function equal(expected: unknown, actual: unknown, field: string): boolean {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    // Project identities are order-insensitive; names and years remain significant.
    return (
      expected.every((item) => typeof item === "string") &&
      actual.every((item) => typeof item === "string") &&
      expected.length === actual.length &&
      JSON.stringify(expected.map(normalise).sort()) ===
        JSON.stringify(actual.map(normalise).sort())
    );
  }
  if (typeof expected === "string" && typeof actual === "string") {
    const expectedText = normalise(expected);
    const actualText = normalise(actual);
    if (field === "supervisorQualification") {
      const year = /\s+\((\d{4})\)$/;
      const expectedYear = expectedText.match(year)?.[1];
      const actualYear = actualText.match(year)?.[1];
      return (
        expectedText.replace(year, "") === actualText.replace(year, "") &&
        (!expectedYear || !actualYear || expectedYear === actualYear)
      );
    }
    return expectedText === actualText;
  }
  return Object.is(expected, actual);
}

function recoveryState(report: Report, scope: "tender" | "supplier", field: string) {
  const root = field.split(".")[0]!;
  const group =
    scope === "tender"
      ? report.tender.groups?.[
          (TENDER_GENERAL_FIELDS as readonly string[]).includes(root) ? "general" : "compliance"
        ]
      : undefined;
  const errors =
    (scope === "tender" ? group?.recovery : report.supplier.recovery)?.fieldErrors ?? {};
  const parts = field.split(".");
  return {
    unavailable:
      (scope === "tender" && report.tender.extracted === null) ||
      (group !== undefined && group.extracted == null) ||
      (scope === "supplier" && report.supplier.extracted === null),
    errors: [
      ...new Set(parts.flatMap((_, index) => errors[parts.slice(0, index + 1).join(".")] ?? [])),
    ],
  };
}

function score(
  schema: z.ZodType,
  expected: unknown,
  actual: unknown,
  field: string,
  scope: "tender" | "supplier",
  report: Report,
  checks: Check[],
): void {
  if (schema instanceof z.ZodNullable) {
    score(schema.unwrap() as z.ZodType, expected, actual, field, scope, report, checks);
    return;
  }
  if (schema instanceof z.ZodObject && isCited(schema)) {
    score(shape(schema).value!, expected, child(actual, "value"), field, scope, report, checks);
    return;
  }
  if (schema instanceof z.ZodObject) {
    for (const [key, member] of Object.entries(shape(schema))) {
      score(
        member,
        child(expected, key),
        child(actual, key),
        field ? `${field}.${key}` : key,
        scope,
        report,
        checks,
      );
    }
    return;
  }
  const value = project(schema, actual);
  const validation = scope === "tender" ? report.tender.validation : report.supplier.validation;
  const fieldCheck = validation.fields?.[field] ?? validation.fields?.[field.split(".")[0]!];
  const recovery = recoveryState(report, scope, field);
  const valueMatches = equal(expected, value, field);
  const structural =
    value === undefined ||
    recovery.unavailable ||
    recovery.errors.some((error) => /structur|omitt|missing required/i.test(error));
  const unverifiableAbsence =
    expected === null &&
    value === null &&
    (scope === "tender" ? !report.tender.groups : !report.supplier.recovery);
  const matches =
    valueMatches && !structural && !unverifiableAbsence && recovery.errors.length === 0;
  const failureType = matches
    ? undefined
    : structural
      ? "structural_failure"
      : unverifiableAbsence
        ? "unverifiable_absence"
        : recovery.errors.length
          ? "unresolved_recovery"
          : expected !== null && value === null
            ? "missed_fact"
            : expected === null && value !== null
              ? "unexpected_value"
              : "wrong_value";
  checks.push({
    field,
    expected,
    actual: value === undefined ? null : value,
    matches,
    valueMatches,
    evidenceStatus: fieldCheck?.status ?? "unknown",
    ...(failureType ? { failureType } : {}),
    ...(value === undefined ? { actualPresence: "omitted" as const } : {}),
  });
}

const metric = <T extends Check>(checks: T[]) => ({
  passed: checks.filter((check) => check.matches).length,
  total: checks.length,
  failed: checks.filter((check) => !check.matches),
  checks,
});

export function evaluateAssessment(report: Report, reference: Reference) {
  const supplier = reference.suppliers.find(
    (entry) => entry.documentId === report.supplier.documentId,
  );
  if (!supplier)
    throw new Error(`No reference supplier for document ${report.supplier.documentId}.`);
  if (!reference.expectedExtraction || !isObject(reference.expectedExtraction.suppliers)) {
    throw new Error("Reference extraction answers are missing.");
  }
  const supplierIds = reference.suppliers.map((entry) => entry.id);
  if (
    new Set(supplierIds).size !== supplierIds.length ||
    Object.keys(reference.expectedExtraction.suppliers).length !== supplierIds.length ||
    supplierIds.some((id) => !Object.hasOwn(reference.expectedExtraction.suppliers, id))
  ) {
    throw new Error("Reference supplier extraction answers are incomplete or unsupported.");
  }
  assertReference(TenderRequirementsSchema, reference.expectedExtraction.tender, "tender");
  for (const id of supplierIds)
    assertReference(SupplierFactsSchema, reference.expectedExtraction.suppliers[id], id);
  const tenderChecks: Check[] = [];
  const supplierChecks: Check[] = [];
  score(
    TenderRequirementsSchema,
    reference.expectedExtraction.tender,
    report.tender.extracted,
    "",
    "tender",
    report,
    tenderChecks,
  );
  score(
    SupplierFactsSchema,
    reference.expectedExtraction.suppliers[supplier.id],
    report.supplier.extracted,
    "",
    "supplier",
    report,
    supplierChecks,
  );
  const tenderAccuracy = metric(tenderChecks);
  const supplierAccuracy = metric(supplierChecks);
  const allChecks = [
    ...tenderChecks.map((check) => ({ scope: "tender" as const, ...check })),
    ...supplierChecks.map((check) => ({ scope: "supplier" as const, ...check })),
  ];
  const factualAccuracy = metric(allChecks);
  const provenanceLimitations = [
    ...(!report.tender.groups && tenderChecks.some((check) => check.actual === null)
      ? ["Tender recovery provenance is unavailable; null values may be legacy placeholders."]
      : []),
    ...(!report.supplier.recovery && supplierChecks.some((check) => check.actual === null)
      ? ["Supplier recovery provenance is unavailable; null values may be legacy placeholders."]
      : []),
  ];
  const deterministicTypes = new Set(["late_completion", "missing_evidence", "conflicting_dates"]);
  const expected = reference.issues
    .filter((issue) => issue.subject === supplier.id && deterministicTypes.has(issue.type))
    .map((issue) => issue.type)
    .sort();
  const actual = report.assessment.findings.map((finding) => finding.type).sort();
  const findingMatches = JSON.stringify(expected) === JSON.stringify(actual);
  return {
    supplierId: supplier.id,
    tenderAccuracy,
    supplierAccuracy,
    factualAccuracy,
    combinedAccuracy: {
      passed: factualAccuracy.passed,
      total: factualAccuracy.total,
      ratio: factualAccuracy.total ? factualAccuracy.passed / factualAccuracy.total : null,
    },
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
    provenanceLimitations,
    procurementReviewStatus: report.assessment.status,
    overallResult:
      factualAccuracy.passed === factualAccuracy.total &&
      findingMatches &&
      report.tender.validation.valid &&
      report.supplier.validation.valid &&
      provenanceLimitations.length === 0
        ? "acceptable"
        : "requires_review",
  };
}
