import { BEDROCK_MODEL_ID, type BedrockExtractionModelId } from "../../bedrock/src/client.ts";
import { compareValidatedCompliance } from "../../comparison/src/compare.ts";
import { estimateAttemptTotals, type InvokeStructured } from "../../extraction/src/facts.ts";
import { extractValidatedSupplierFacts } from "../../extraction/src/supplier.ts";
import { extractValidatedTenderRequirements } from "../../extraction/src/tender.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";

export async function runTenderAssessment(
  tenderDocument: ExtractedPdf,
  supplierDocument: ExtractedPdf,
  generalInvoke?: InvokeStructured,
  complianceInvoke?: InvokeStructured,
  supplierInvoke?: InvokeStructured,
  modelId: BedrockExtractionModelId = BEDROCK_MODEL_ID,
) {
  const tender = await extractValidatedTenderRequirements(
    tenderDocument,
    generalInvoke,
    complianceInvoke,
    modelId,
  );
  const supplier = await extractValidatedSupplierFacts(supplierDocument, supplierInvoke, modelId);
  const attempts = [...tender.attempts, ...supplier.attempts];
  return {
    schemaVersion: 1 as const,
    tender,
    supplier,
    assessment: compareValidatedCompliance(tender, supplier),
    ...estimateAttemptTotals(attempts),
  };
}
