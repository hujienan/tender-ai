import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import {
  extractSupplierFacts,
  extractTenderRequirements,
  type ExtractionReport,
  type InvokeStructured,
} from "../../extraction/src/facts.ts";
import type { SupplierFacts, TenderRequirements } from "../../extraction/src/schema.ts";
import { compareCompliance } from "./compare.ts";

export function buildAssessment(
  tender: ExtractionReport<TenderRequirements>,
  supplier: ExtractionReport<SupplierFacts>,
) {
  const attempts = [...tender.attempts, ...supplier.attempts];
  return {
    version: "2c" as const,
    tender,
    supplier,
    assessment: compareCompliance(tender, supplier),
    totalEstimatedCostUsd: attempts.every((attempt) => attempt.costEstimate !== null)
      ? attempts.reduce((total, attempt) => total + (attempt.costEstimate?.estimatedUsd ?? 0), 0)
      : null,
  };
}

export async function runAssessment(
  tenderDocument: ExtractedPdf,
  supplierDocument: ExtractedPdf,
  tenderInvoke?: InvokeStructured,
  supplierInvoke?: InvokeStructured,
) {
  const tender = await extractTenderRequirements(tenderDocument, tenderInvoke);
  const supplier = await extractSupplierFacts(supplierDocument, supplierInvoke);
  return buildAssessment(tender, supplier);
}
