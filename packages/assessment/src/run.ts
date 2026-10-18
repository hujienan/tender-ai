import { BEDROCK_MODEL_ID, type BedrockExtractionModelId } from "../../bedrock/src/client.ts";
import { compareValidatedCompliance } from "../../comparison/src/compare.ts";
import { estimateAttemptTotals, type InvokeStructured } from "../../extraction/src/facts.ts";
import { extractValidatedSupplierFacts } from "../../extraction/src/supplier.ts";
import { extractValidatedTenderRequirements } from "../../extraction/src/tender.ts";
import type { EmbeddingProvider } from "../../indexing/src/index.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { retrievedPassages, supplierGroundingErrors, tenderGroundingErrors } from "./grounding.ts";
import { prepareRetrievalContexts, type AssessmentRetrievalStore } from "./retrieval-context.ts";

export type AssessmentOptions =
  | { mode?: "full" }
  | { mode: "rag"; embeddingProvider: EmbeddingProvider; retrievalStore: AssessmentRetrievalStore };

export async function runTenderAssessment(
  tenderDocument: ExtractedPdf,
  supplierDocument: ExtractedPdf,
  generalInvoke?: InvokeStructured,
  complianceInvoke?: InvokeStructured,
  supplierInvoke?: InvokeStructured,
  modelId: BedrockExtractionModelId = BEDROCK_MODEL_ID,
  options?: AssessmentOptions,
) {
  const prepared =
    options?.mode === "rag"
      ? await prepareRetrievalContexts(
          tenderDocument,
          supplierDocument,
          options.embeddingProvider,
          options.retrievalStore,
        )
      : null;
  const passages = prepared
    ? retrievedPassages(tenderDocument, supplierDocument, prepared.diagnostics)
    : null;
  const tender = await extractValidatedTenderRequirements(
    tenderDocument,
    generalInvoke,
    complianceInvoke,
    modelId,
    prepared?.contexts,
    passages
      ? {
          general: (facts) =>
            tenderGroundingErrors(facts, tenderDocument.documentId, passages.general),
          compliance: (facts) =>
            tenderGroundingErrors(facts, tenderDocument.documentId, passages.compliance),
        }
      : undefined,
  );
  const supplier = await extractValidatedSupplierFacts(
    supplierDocument,
    supplierInvoke,
    modelId,
    prepared?.contexts.supplier,
    passages
      ? (facts) => supplierGroundingErrors(facts, supplierDocument.documentId, passages.supplier)
      : undefined,
  );
  const attempts = [...tender.attempts, ...supplier.attempts];
  return {
    schemaVersion: 1 as const,
    mode: options?.mode ?? ("full" as const),
    tender,
    supplier,
    assessment: compareValidatedCompliance(tender, supplier),
    ...estimateAttemptTotals(attempts),
    ...(prepared ? { retrieval: prepared.diagnostics } : {}),
  };
}
