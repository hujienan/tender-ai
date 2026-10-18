import { BEDROCK_MODEL_ID, type BedrockExtractionModelId } from "../../bedrock/src/client.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { extractSupplierFacts, type InvokeStructured } from "./facts.ts";
import { SUPPLIER_FIELDS, validateSupplierFields } from "./field-validation.ts";
import { recoverStructuredExtraction } from "./recovery.ts";
import { SupplierFactsSchema, type SupplierFacts } from "./schema.ts";

const EMPTY_SUPPLIER: SupplierFacts = {
  supplierName: null,
  priceExGst: null,
  currency: null,
  proposedDurationWeeks: null,
  warranty: null,
  programmeCompletionDate: null,
  commercialCompletionDate: null,
  contractorLicence: null,
  supervisorQualification: null,
  comparableReferences: [],
  insuranceEvidence: { publicLiability: null, workersCompensation: null },
};
const SUPPLIER_RECOVERY_FIELDS = [
  ...SUPPLIER_FIELDS,
  "insuranceEvidence.publicLiability",
  "insuranceEvidence.workersCompensation",
];

export async function extractValidatedSupplierFacts(
  document: ExtractedPdf,
  invoke?: InvokeStructured,
  modelId: BedrockExtractionModelId = BEDROCK_MODEL_ID,
) {
  const report = await recoverStructuredExtraction(
    () => extractSupplierFacts(document, invoke, modelId),
    SupplierFactsSchema,
    EMPTY_SUPPLIER,
    SUPPLIER_RECOVERY_FIELDS,
    "extract_supplier_facts",
    (facts, fieldErrors) => validateSupplierFields(facts, document, [], fieldErrors),
  );
  return {
    ...report,
    validation: validateSupplierFields(
      report.extracted,
      document,
      report.extracted ? [] : report.validation.errors,
      report.recovery?.fieldErrors,
    ),
  };
}
