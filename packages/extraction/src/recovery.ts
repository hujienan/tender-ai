import type { z } from "zod";
import { estimateAttemptTotals, type ExtractionReport } from "./facts.ts";
import type { FieldValidation } from "./field-validation.ts";

type Provenance = NonNullable<ExtractionReport<unknown>["recovery"]>["recoveredFields"];

function fieldValue(value: unknown, field: string): unknown {
  if (field.startsWith("insuranceEvidence.")) {
    const kind = field.split(".")[1]!;
    const insurance =
      value && typeof value === "object" && "insuranceEvidence" in value
        ? value.insuranceEvidence
        : null;
    return insurance && typeof insurance === "object" && kind in insurance
      ? insurance[kind as keyof typeof insurance]
      : undefined;
  }
  return value && typeof value === "object" && field in value
    ? value[field as keyof typeof value]
    : undefined;
}

function withField<T extends object>(base: T, field: string, value: unknown): T {
  if (field.startsWith("insuranceEvidence.")) {
    const kind = field.split(".")[1]!;
    return {
      ...base,
      insuranceEvidence: {
        ...(base as { insuranceEvidence: object }).insuranceEvidence,
        [kind]: value,
      },
    } as T;
  }
  return { ...base, [field]: value };
}

export async function recoverStructuredExtraction<T extends object>(
  invokeOnce: (feedback?: string) => Promise<ExtractionReport<T>>,
  schema: z.ZodType<T>,
  empty: T,
  fields: readonly string[],
  toolName: string,
  validate: (facts: T, fieldErrors: Record<string, string[]>) => FieldValidation,
): Promise<ExtractionReport<T>> {
  const first = await invokeOnce();
  if (first.extracted) {
    const checked = validate(first.extracted, {});
    return {
      ...first,
      recovery: {
        retried: false,
        recoveredFields: {},
        unresolvedFields: Object.entries(checked.fields)
          .filter(
            ([field, result]) =>
              result.status !== "valid" &&
              fields.some(
                (requested) =>
                  field === requested ||
                  field.startsWith(requested + ".") ||
                  field.startsWith(requested + "["),
              ),
          )
          .map(([field]) => field),
        fieldErrors: {},
      },
    };
  }

  const feedback = first.attempts.some((attempt) => attempt.rawResponse)
    ? first.validation.errors.slice(0, 3).join("; ")
    : undefined;
  const second = await invokeOnce(feedback);
  const attempts = [...first.attempts, ...second.attempts];
  const recoveredFields: Provenance = {};
  const fieldErrors: Record<string, string[]> = {};
  const unresolvedFields: string[] = [];
  let extracted = { ...empty };
  let recoveredAny = false;

  for (const field of fields) {
    const candidates = attempts.flatMap((attempt, index) =>
      (attempt.rawResponse?.tool_calls ?? [])
        .filter((call) => call.name === toolName)
        .map((call) => ({
          attempt: index + 1,
          toolCallId: call.id ?? null,
          value: fieldValue(call.args, field),
        }))
        .filter((candidate) => candidate.value !== undefined && candidate.value !== null),
    );
    const validShapes = candidates.flatMap((candidate) => {
      const checked = schema.safeParse(withField(empty, field, candidate.value));
      return checked.success ? [{ ...candidate, value: fieldValue(checked.data, field) }] : [];
    });
    if (validShapes.length === 0) {
      unresolvedFields.push(field);
      if (fieldValue(second.extracted, field) === null) continue;
      const targets = field.startsWith("insuranceEvidence.")
        ? [`${field}.status`, `${field}.policyId`]
        : [field];
      for (const target of targets) {
        fieldErrors[target] = [`${target}: no structurally valid response value was recovered.`];
      }
      continue;
    }
    const checked = validShapes.map((candidate) => ({
      ...candidate,
      check: validate(withField(empty, field, candidate.value), {}),
    }));
    const supported = (candidate: (typeof checked)[number], part: string) =>
      candidate.check.fields[part]?.status === "valid";
    const insurance = field.startsWith("insuranceEvidence.");
    const usable = insurance
      ? (checked.find(
          (candidate) =>
            supported(candidate, `${field}.status`) && supported(candidate, `${field}.policyId`),
        ) ??
        checked.find((candidate) => supported(candidate, `${field}.status`)) ??
        checked.find((candidate) => supported(candidate, `${field}.policyId`)))
      : checked.find((candidate) => supported(candidate, field));
    if (!usable) {
      unresolvedFields.push(field);
      const targets = field.startsWith("insuranceEvidence.")
        ? [`${field}.status`, `${field}.policyId`]
        : [field];
      for (const target of targets) {
        fieldErrors[target] = [`${target}: no candidate passed source evidence validation.`];
      }
      continue;
    }
    if (!insurance) {
      const values = new Set(
        checked
          .filter((candidate) => supported(candidate, field))
          .map((candidate) => {
            const value = candidate.value as { value?: unknown };
            return JSON.stringify(value?.value ?? value);
          }),
      );
      if (values.size > 1) {
        unresolvedFields.push(field);
        fieldErrors[field] = [`${field}: conflicting values across model attempts or tool calls.`];
        continue;
      }
    }
    extracted = withField(extracted, field, usable.value);
    recoveredAny = true;
    recoveredFields[field] = {
      attempt: usable.attempt,
      toolCallId: usable.toolCallId,
      evidence: (usable.value as { evidence?: unknown }).evidence ?? null,
    };
    if (field.startsWith("insuranceEvidence.")) {
      const statuses = new Set(
        checked
          .filter((candidate) => supported(candidate, `${field}.status`))
          .map((candidate) =>
            JSON.stringify((candidate.value as { value: { status: string } }).value.status),
          ),
      );
      const ids = new Set(
        checked
          .filter((candidate) => supported(candidate, `${field}.policyId`))
          .map(
            (candidate) =>
              (candidate.value as { value: { policyId: string | null } }).value.policyId,
          )
          .filter((id) => id !== null),
      );
      for (const [part, conflict] of [
        ["status", statuses.size > 1],
        ["policyId", ids.size > 1],
      ] as const) {
        if (conflict) {
          fieldErrors[`${field}.${part}`] = [
            `${field}.${part}: conflicting values across model attempts or tool calls.`,
          ];
          unresolvedFields.push(`${field}.${part}`);
        }
      }
    }
  }

  const parsed = recoveredAny ? schema.safeParse(extracted) : null;
  const facts = parsed?.success ? parsed.data : null;
  const validation = facts
    ? validate(facts, fieldErrors)
    : {
        valid: false,
        errors: [
          ...first.validation.errors,
          ...second.validation.errors,
          ...Object.values(fieldErrors).flat(),
        ],
      };
  if ("fields" in validation) {
    unresolvedFields.push(
      ...Object.entries(validation.fields)
        .filter(
          ([field, result]) =>
            result.status !== "valid" &&
            fields.some(
              (requested) =>
                field === requested ||
                field.startsWith(requested + ".") ||
                field.startsWith(requested + "["),
            ),
        )
        .map(([field]) => field),
    );
  }
  return {
    ...second,
    extracted: facts,
    validation,
    attempts,
    ...estimateAttemptTotals(attempts),
    recovery: {
      retried: true,
      recoveredFields,
      unresolvedFields: [...new Set(unresolvedFields)],
      fieldErrors,
    },
  };
}
