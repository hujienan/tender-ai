import { chunkDocument } from "../../indexing/src/chunk.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { normalise, validateTenderRequirements } from "../../extraction/src/evidence.ts";
import {
  EMPTY_TENDER,
  mergeFieldErrors,
  validateSupplierFields,
  validateTenderFields,
} from "../../extraction/src/field-validation.ts";
import type { Evidence, SupplierFacts, TenderRequirements } from "../../extraction/src/schema.ts";

export type RetrievalGroup = "general" | "compliance" | "supplier";
export type RetrievalProvenance = {
  queries: {
    group: RetrievalGroup;
    documentIds: string[];
    chunks: { documentId: string; pageNumber: number; chunkIndex: number }[];
  }[];
};
type Passage = { documentId: string; pageNumber: number; text: string };
export type GroundingErrors = Record<string, string[]>;

export function retrievedPassages(
  tender: ExtractedPdf,
  supplier: ExtractedPdf,
  provenance: RetrievalProvenance,
): Record<RetrievalGroup, Passage[]> {
  const result = {} as Record<RetrievalGroup, Passage[]>;
  for (const group of ["general", "compliance", "supplier"] as const) {
    const document = group === "supplier" ? supplier : tender;
    const chunks = new Map(chunkDocument(document).map((chunk) => [chunk.chunkIndex, chunk]));
    const queries = provenance.queries.filter((entry) => entry.group === group);
    if (queries.length === 0)
      throw new Error("RAG retrieval metadata is missing " + group + " queries.");
    const selected = new Map<number, Passage>();
    for (const query of queries) {
      if (query.documentIds.length !== 1 || query.documentIds[0] !== document.documentId) {
        throw new Error("RAG retrieval metadata has the wrong document for " + group + ".");
      }
      for (const ref of query.chunks) {
        const chunk = chunks.get(ref.chunkIndex);
        if (
          ref.documentId !== document.documentId ||
          !chunk ||
          ref.pageNumber !== chunk.pageNumber
        ) {
          throw new Error("RAG retrieval metadata has an invalid chunk for " + group + ".");
        }
        selected.set(ref.chunkIndex, {
          documentId: document.documentId,
          pageNumber: chunk.pageNumber,
          text: chunk.text,
        });
      }
    }
    result[group] = [...selected.values()];
  }
  return result;
}

function citationErrors(evidence: Evidence[], documentId: string, passages: Passage[]): string[] {
  return evidence.flatMap((citation, index) => {
    const quote = normalise(citation.quote);
    return citation.documentId === documentId &&
      quote &&
      passages.some(
        (passage) =>
          passage.documentId === citation.documentId &&
          passage.pageNumber === citation.page &&
          normalise(passage.text).includes(quote),
      )
      ? []
      : ["Citation " + (index + 1) + " was not supplied in this extraction's retrieved passages."];
  });
}

export function tenderGroundingErrors(
  facts: Partial<TenderRequirements>,
  documentId: string,
  passages: Passage[],
): GroundingErrors {
  const errors: GroundingErrors = {};
  for (const [field, fact] of Object.entries(facts)) {
    if (!fact) continue;
    const unsupported = citationErrors(fact.evidence, documentId, passages);
    if (unsupported.length) errors[field] = unsupported;
  }
  return errors;
}

export function supplierGroundingErrors(
  facts: SupplierFacts | null,
  documentId: string,
  passages: Passage[],
): GroundingErrors {
  const errors: GroundingErrors = {};
  if (!facts) return errors;
  for (const [field, fact] of Object.entries(facts)) {
    if (field === "insuranceEvidence") {
      for (const [kind, insurance] of Object.entries(facts.insuranceEvidence)) {
        if (!insurance) continue;
        const unsupported = citationErrors(insurance.evidence, documentId, passages);
        if (unsupported.length) {
          errors["insuranceEvidence." + kind + ".status"] = unsupported;
          if (insurance.value.policyId !== null) {
            errors["insuranceEvidence." + kind + ".policyId"] = unsupported;
          }
        }
      }
    } else if (field === "comparableReferences") {
      facts.comparableReferences.forEach((reference, index) => {
        const unsupported = citationErrors(reference.evidence, documentId, passages);
        if (unsupported.length) {
          errors["comparableReferences"] = [
            ...(errors["comparableReferences"] ?? []),
            ...unsupported,
          ];
          errors["comparableReferences[" + index + "]"] = unsupported;
        }
      });
    } else if (fact) {
      const unsupported = citationErrors(
        (fact as { evidence: Evidence[] }).evidence,
        documentId,
        passages,
      );
      if (unsupported.length) errors[field] = unsupported;
    }
  }
  return errors;
}

export function addGroundingErrors<T extends { valid: boolean; errors: string[] }>(
  validation: T,
  grounding: GroundingErrors,
): T {
  const errors = Object.values(grounding).flat();
  return {
    ...validation,
    valid: validation.valid && errors.length === 0,
    errors: [...validation.errors, ...errors],
  };
}

type GroupReport = {
  extracted: Partial<TenderRequirements> | null;
  validation: { valid: boolean; errors: string[] };
  recovery?: { fieldErrors: GroundingErrors } | undefined;
};
type TenderReport = {
  extracted: TenderRequirements;
  groups: { general: GroupReport; compliance: GroupReport };
};
type SupplierReport = {
  extracted: SupplierFacts | null;
  validation: { valid: boolean; errors: string[] };
  recovery?: { fieldErrors: GroundingErrors } | undefined;
};

export function applyRagGrounding<T extends TenderReport, S extends SupplierReport>(
  tender: T,
  supplier: S,
  tenderPdf: ExtractedPdf,
  supplierPdf: ExtractedPdf,
  provenance: RetrievalProvenance,
) {
  const passages = retrievedPassages(tenderPdf, supplierPdf, provenance);
  const generalErrors = tenderGroundingErrors(
    tender.groups.general.extracted ?? {},
    tenderPdf.documentId,
    passages.general,
  );
  const complianceErrors = tenderGroundingErrors(
    tender.groups.compliance.extracted ?? {},
    tenderPdf.documentId,
    passages.compliance,
  );
  const supplierErrors = supplierGroundingErrors(
    supplier.extracted,
    supplierPdf.documentId,
    passages.supplier,
  );
  const groundedTender = {
    ...tender,
    groups: {
      general: {
        ...tender.groups.general,
        validation: addGroundingErrors(
          tender.groups.general.extracted
            ? validateTenderRequirements(
                { ...EMPTY_TENDER, ...tender.groups.general.extracted },
                tenderPdf,
              )
            : tender.groups.general.validation,
          mergeFieldErrors(
            tender.groups.general.extracted
              ? (tender.groups.general.recovery?.fieldErrors ?? {})
              : {},
            generalErrors,
          ),
        ),
      },
      compliance: {
        ...tender.groups.compliance,
        validation: addGroundingErrors(
          tender.groups.compliance.extracted
            ? validateTenderRequirements(
                { ...EMPTY_TENDER, ...tender.groups.compliance.extracted },
                tenderPdf,
              )
            : tender.groups.compliance.validation,
          mergeFieldErrors(
            tender.groups.compliance.extracted
              ? (tender.groups.compliance.recovery?.fieldErrors ?? {})
              : {},
            complianceErrors,
          ),
        ),
      },
    },
    validation: validateTenderFields(
      tender.extracted,
      tenderPdf,
      {
        ...(tender.groups.general.extracted
          ? {}
          : { general: tender.groups.general.validation.errors }),
        ...(tender.groups.compliance.extracted
          ? {}
          : { compliance: tender.groups.compliance.validation.errors }),
      },
      mergeFieldErrors(
        tender.groups.general.recovery?.fieldErrors ?? {},
        tender.groups.compliance.recovery?.fieldErrors ?? {},
        generalErrors,
        complianceErrors,
      ),
    ),
  };
  const groundedSupplier = {
    ...supplier,
    validation: validateSupplierFields(
      supplier.extracted,
      supplierPdf,
      supplier.extracted ? [] : supplier.validation.errors,
      mergeFieldErrors(supplier.recovery?.fieldErrors ?? {}, supplierErrors),
    ),
  };
  return { tender: groundedTender, supplier: groundedSupplier };
}
