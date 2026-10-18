import { z } from "zod";

export const EvidenceSchema = z
  .object({
    documentId: z.string().min(1),
    page: z.number().int().positive(),
    quote: z.string().min(1),
  })
  .strict();

const cited = <T extends z.ZodType>(value: T) =>
  z.object({ value, evidence: z.array(EvidenceSchema).min(1) }).strict();

const insurance = cited(
  z
    .object({
      status: z.enum(["attached", "explicitly_missing", "claimed_only"]),
      policyId: z
        .string()
        .min(1)
        .nullable()
        .describe(
          "Explicitly labelled insurance policy or certificate identifier only; a coverage amount is not an identifier. Use JSON null when no identifier is provided.",
        ),
    })
    .strict(),
);

export const SupplierFactsSchema = z
  .object({
    supplierName: cited(z.string().min(1)).nullable(),
    priceExGst: cited(z.number().nonnegative()).nullable(),
    currency: cited(z.string().regex(/^[A-Z]{3}$/)).nullable(),
    proposedDurationWeeks: cited(z.number().int().positive()).nullable(),
    warranty: cited(
      z
        .object({
          months: z.number().int().positive().nullable(),
          conditions: z.string().min(1).nullable(),
        })
        .strict(),
    ).nullable(),
    programmeCompletionDate: cited(z.iso.date()).nullable(),
    commercialCompletionDate: cited(z.iso.date()).nullable(),
    contractorLicence: cited(z.string().min(1)).nullable(),
    supervisorQualification: cited(z.string().min(1)).nullable(),
    comparableReferences: z.array(cited(z.string().min(1))),
    insuranceEvidence: z
      .object({
        publicLiability: insurance.nullable(),
        workersCompensation: insurance.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((facts, context) => {
    function rejectLiteralNull(value: unknown, path: (string | number)[] = []) {
      if (typeof value === "string" && value.trim().toLowerCase() === "null") {
        context.addIssue({
          code: "custom",
          path,
          message: "Use JSON null, not the string 'null'.",
        });
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => rejectLiteralNull(item, [...path, index]));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) rejectLiteralNull(child, [...path, key]);
      }
    }
    rejectLiteralNull(facts);
  });

const citedDate = cited(z.iso.date()).nullable();
const citedRequirement = cited(z.boolean()).nullable();
export const TenderRequirementsSchema = z
  .object({
    tenderId: cited(z.string().min(1)).nullable(),
    closingDate: citedDate,
    siteAccessDate: citedDate,
    requiredPracticalCompletionDate: citedDate,
    requiredCurrency: cited(z.string().regex(/^[A-Z]{3}$/)).nullable(),
    minimumComparableReferences: cited(z.number().int().nonnegative()).nullable(),
    publicLiabilityCertificateRequired: citedRequirement,
    workersCompensationCertificateRequired: citedRequirement,
  })
  .strict();

export const GeneralRequirementsSchema = TenderRequirementsSchema.pick({
  tenderId: true,
  closingDate: true,
  siteAccessDate: true,
  requiredPracticalCompletionDate: true,
  requiredCurrency: true,
});
export const ComplianceRequirementsSchema = TenderRequirementsSchema.pick({
  minimumComparableReferences: true,
  publicLiabilityCertificateRequired: true,
  workersCompensationCertificateRequired: true,
});

// Nova Converse accepts only these three top-level tool schema keys; Zod still validates the response.
export function toolSchema(schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema);
  return { type: "object", properties: jsonSchema.properties, required: jsonSchema.required };
}
export const SupplierFactsToolSchema = toolSchema(SupplierFactsSchema);

export type Evidence = z.infer<typeof EvidenceSchema>;
export type SupplierFacts = z.infer<typeof SupplierFactsSchema>;
export type TenderRequirements = z.infer<typeof TenderRequirementsSchema>;
