import { z } from "zod";
import { CHUNKER_VERSION, chunkDocument, documentContentHash } from "../../indexing/src/chunk.ts";
import type { DocumentChunk } from "../../indexing/src/chunk.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import { TENDER_GENERAL_FIELDS } from "../../extraction/src/field-validation.ts";
import { SupplierFactsSchema, TenderRequirementsSchema } from "../../extraction/src/schema.ts";
import { evaluateAssessment } from "./evaluate.ts";

const sourceSchema = z.object({ page: z.number().int().positive(), quote: z.string().min(1) });
const evidenceFieldSchema = z.object({
  state: z.enum(["supported", "explicit_absence"]),
  evidence: z.array(z.array(sourceSchema).min(1)).min(1),
});
const unstatedFieldSchema = z.object({ state: z.literal("not_stated"), reason: z.string().min(1) });
const referenceSchema = z.object({
  datasetId: z.string(),
  chunkerVersion: z.string(),
  sourceContentSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  queries: z.array(
    z.object({
      group: z.enum(["general", "compliance", "supplier"]),
      query: z.string().min(1),
      fields: z.array(z.string().min(1)).min(1),
    }),
  ),
  fields: z.record(
    z.string(),
    z.record(z.string(), z.union([evidenceFieldSchema, unstatedFieldSchema])),
  ),
});
const chunkRefSchema = z.object({
  documentId: z.string(),
  pageNumber: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative(),
  contentSha256: z.string().optional(),
});
const validationSchema = z
  .object({
    valid: z.boolean(),
    fields: z
      .record(z.string(), z.object({ status: z.string(), errors: z.array(z.string()).optional() }))
      .optional(),
  })
  .passthrough();
const recoverySchema = z.object({
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
const groupSchema = z.object({
  extracted: z.unknown().optional(),
  recovery: recoverySchema.optional(),
});
const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("rag"),
    retrieval: z.object({
      queries: z.array(
        z.object({
          group: z.enum(["general", "compliance", "supplier"]),
          query: z.string().min(1),
          documentIds: z.array(z.string()),
          chunks: z.array(chunkRefSchema).max(2),
        }),
      ),
      groupChunkCounts: z
        .object({
          general: z.number().int().nonnegative(),
          compliance: z.number().int().nonnegative(),
          supplier: z.number().int().nonnegative(),
        })
        .optional(),
      distinctChunkCount: z.number().int().nonnegative().optional(),
      embeddingRequests: z.number().int().nonnegative().optional(),
    }),
    tender: z.object({
      extracted: TenderRequirementsSchema.nullable(),
      validation: validationSchema,
      groups: z.object({ general: groupSchema, compliance: groupSchema }).optional(),
    }),
    supplier: z.object({
      documentId: z.string(),
      extracted: SupplierFactsSchema.nullable(),
      validation: validationSchema,
      recovery: recoverySchema.optional(),
    }),
    assessment: z.object({
      status: z.string(),
      findings: z.array(z.object({ type: z.string() })),
    }),
  })
  .passthrough();

type Annotation = z.infer<typeof evidenceFieldSchema> | z.infer<typeof unstatedFieldSchema>;
type SourceLocation = { page: number; quote: string; chunkIndexes: number[][] };
type ResolvedField = {
  state: Annotation["state"];
  alternatives: SourceLocation[][];
  relevant: Set<number>;
};

function resolveField(
  annotation: Annotation,
  pdf: ExtractedPdf,
  chunks: DocumentChunk[],
): ResolvedField {
  if (annotation.state === "not_stated") {
    return { state: annotation.state, alternatives: [], relevant: new Set() };
  }
  const relevant = new Set<number>();
  const alternatives = annotation.evidence.map((sources) =>
    sources.map(({ page, quote }) => {
      const text = pdf.pages[page - 1]?.text;
      if (pdf.pages[page - 1]?.page !== page || !text) {
        throw new Error(`Retrieval annotation has an invalid page for ${pdf.documentId}.`);
      }
      const chunkIndexes: number[][] = [];
      for (
        let offset = text.indexOf(quote);
        offset !== -1;
        offset = text.indexOf(quote, offset + 1)
      ) {
        const indexes = chunks
          .filter(
            (chunk) =>
              chunk.pageNumber === page &&
              chunk.startOffset < offset + quote.length &&
              chunk.endOffset > offset,
          )
          .map((chunk) => chunk.chunkIndex);
        if (indexes.length === 0)
          throw new Error(`No chunk contains ${pdf.documentId} page ${page} evidence.`);
        indexes.forEach((index) => relevant.add(index));
        chunkIndexes.push(indexes);
      }
      if (chunkIndexes.length === 0) {
        throw new Error(
          `Retrieval annotation quote is absent from ${pdf.documentId} page ${page}: ${quote}`,
        );
      }
      return { page, quote, chunkIndexes };
    }),
  );
  return { state: annotation.state, alternatives, relevant };
}

function available(field: ResolvedField, selected: Set<number>): boolean | null {
  if (field.state === "not_stated") return null;
  return field.alternatives.some((sources) =>
    sources.every((source) =>
      source.chunkIndexes.some((indexes) => indexes.every((index) => selected.has(index))),
    ),
  );
}

function coverage(fields: { evidenceAvailable: boolean | null }[]) {
  const total = fields.filter((field) => field.evidenceAvailable !== null).length;
  const covered = fields.filter((field) => field.evidenceAvailable === true).length;
  return {
    covered,
    total,
    ratio: total ? covered / total : null,
    sourceAbsent: fields.length - total,
  };
}

type ExtractionReference = Parameters<typeof evaluateAssessment>[1] & { datasetId?: string };

export function evaluateRetrieval(
  saved: unknown,
  extractionReference: ExtractionReference,
  retrievalReference: unknown,
  tenderPdf: ExtractedPdf,
  supplierPdf: ExtractedPdf,
) {
  if ((saved as { mode?: unknown } | null)?.mode === "full") {
    throw new Error("Full-document reports have no RAG retrieval results; use a RAG report.");
  }
  const report = reportSchema.parse(saved);
  const labels = referenceSchema.parse(retrievalReference);
  if (labels.datasetId !== extractionReference.datasetId) {
    throw new Error("Retrieval and extraction references identify different datasets.");
  }
  if (labels.chunkerVersion !== CHUNKER_VERSION) {
    throw new Error("Retrieval annotations use an incompatible chunker version.");
  }
  if (tenderPdf.documentId !== "tender" || supplierPdf.documentId !== report.supplier.documentId) {
    throw new Error("Source PDF document IDs do not match the saved RAG report.");
  }
  const chunks = new Map<string, DocumentChunk[]>();
  for (const pdf of [tenderPdf, supplierPdf]) {
    if (documentContentHash(pdf) !== labels.sourceContentSha256[pdf.documentId]) {
      throw new Error(`Source PDF ${pdf.documentId} differs from retrieval annotations.`);
    }
    chunks.set(pdf.documentId, chunkDocument(pdf));
  }
  const extraction = evaluateAssessment(report, extractionReference);
  const checks = {
    tender: new Map(extraction.tenderAccuracy.checks.map((check) => [check.field, check])),
    supplier: new Map(extraction.supplierAccuracy.checks.map((check) => [check.field, check])),
  };
  const resolved = new Map<string, Map<string, ResolvedField>>();
  for (const [documentId, checkSet] of [
    ["tender", checks.tender],
    [supplierPdf.documentId, checks.supplier],
  ] as const) {
    const annotations = labels.fields[documentId];
    const pdf = documentId === "tender" ? tenderPdf : supplierPdf;
    const documentChunks = chunks.get(documentId)!;
    if (
      !annotations ||
      Object.keys(annotations).length !== checkSet.size ||
      [...checkSet.keys()].some((field) => !Object.hasOwn(annotations, field))
    ) {
      throw new Error(`Retrieval annotations do not cover every scored field for ${documentId}.`);
    }
    const fields = new Map<string, ResolvedField>();
    for (const [field, annotation] of Object.entries(annotations)) {
      const resolvedField = resolveField(annotation, pdf, documentChunks);
      if (annotation.state === "not_stated" && checkSet.get(field)?.expected !== null) {
        throw new Error(`Only expected null fields may be marked not_stated: ${field}.`);
      }
      fields.set(field, resolvedField);
    }
    resolved.set(documentId, fields);
  }
  const expectedQueries = new Map(
    labels.queries.map((entry) => [entry.group + ":" + entry.query, entry]),
  );
  if (
    expectedQueries.size !== labels.queries.length ||
    report.retrieval.queries.length !== labels.queries.length
  ) {
    throw new Error("RAG query metadata or retrieval annotations are incomplete.");
  }
  const seenQueries = new Set<string>();
  const groups = {
    general: new Set<number>(),
    compliance: new Set<number>(),
    supplier: new Set<number>(),
  };
  const assigned = {
    general: new Set<string>(),
    compliance: new Set<string>(),
    supplier: new Set<string>(),
  };
  const queryResults = report.retrieval.queries.map((query) => {
    const key = query.group + ":" + query.query;
    const definition = expectedQueries.get(key);
    const documentId = query.group === "supplier" ? supplierPdf.documentId : tenderPdf.documentId;
    if (!definition || seenQueries.has(key))
      throw new Error(`Unsupported or duplicate RAG query: ${key}.`);
    seenQueries.add(key);
    if (query.documentIds.length !== 1 || query.documentIds[0] !== documentId) {
      throw new Error(`RAG query ${key} requested the wrong source document.`);
    }
    const documentChunks = chunks.get(documentId)!;
    const ranked = query.chunks.map((ref, index) => {
      const chunk = documentChunks[ref.chunkIndex];
      if (
        ref.documentId !== documentId ||
        !chunk ||
        ref.pageNumber !== chunk.pageNumber ||
        (ref.contentSha256 && ref.contentSha256 !== chunk.contentSha256)
      ) {
        throw new Error(`RAG query ${key} has stale or incompatible chunk provenance.`);
      }
      groups[query.group].add(chunk.chunkIndex);
      return {
        rank: index + 1,
        documentId,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        contentSha256: chunk.contentSha256,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      };
    });
    const fieldMap = resolved.get(documentId)!;
    for (const field of definition.fields) {
      if (
        !fieldMap.has(field) ||
        assigned[query.group].has(field) ||
        (query.group !== "supplier" &&
          (TENDER_GENERAL_FIELDS as readonly string[]).includes(field) !==
            (query.group === "general"))
      ) {
        throw new Error(`RAG query annotation has an unsupported or duplicate field: ${field}.`);
      }
      assigned[query.group].add(field);
    }
    const relevant = new Set(
      definition.fields.flatMap((field) => [...fieldMap.get(field)!.relevant]),
    );
    const fieldResults = definition.fields.map((field) => ({
      field,
      evidenceAvailable: available(
        fieldMap.get(field)!,
        new Set(ranked.map((chunk) => chunk.chunkIndex)),
      ),
    }));
    const recallAtK = Object.fromEntries(
      [1, 2].map((k) => {
        const found = new Set(ranked.slice(0, k).map((chunk) => chunk.chunkIndex));
        const hits = [...relevant].filter((index) => found.has(index)).length;
        return [
          k,
          { hits, relevant: relevant.size, value: relevant.size ? hits / relevant.size : null },
        ];
      }),
    );
    return {
      group: query.group,
      query: query.query,
      documentIds: query.documentIds,
      rankedChunks: ranked.map((chunk) => ({ ...chunk, relevant: relevant.has(chunk.chunkIndex) })),
      relevantChunks: [...relevant]
        .sort((a, b) => a - b)
        .map((index) => ({
          documentId,
          pageNumber: documentChunks[index]!.pageNumber,
          chunkIndex: index,
        })),
      fields: fieldResults,
      evidenceHitRate: coverage(fieldResults),
      recallAtK,
    };
  });
  for (const group of ["general", "compliance", "supplier"] as const) {
    const savedCount = report.retrieval.groupChunkCounts?.[group];
    if (savedCount !== undefined && savedCount !== groups[group].size) {
      throw new Error(`RAG retrieval groupChunkCounts.${group} contradicts saved queries.`);
    }
  }
  const distinctChunkCount = new Set(
    queryResults.flatMap((query) =>
      query.rankedChunks.map((chunk) => `${chunk.documentId}:${chunk.chunkIndex}`),
    ),
  ).size;
  if (
    report.retrieval.distinctChunkCount !== undefined &&
    report.retrieval.distinctChunkCount !== distinctChunkCount
  ) {
    throw new Error("RAG retrieval distinctChunkCount contradicts saved queries.");
  }
  if (
    report.retrieval.embeddingRequests !== undefined &&
    report.retrieval.embeddingRequests !== queryResults.length
  ) {
    throw new Error("RAG retrieval embeddingRequests contradicts saved queries.");
  }
  const assignedTender = new Set([...assigned.general, ...assigned.compliance]);
  if (
    assignedTender.size !== checks.tender.size ||
    [...checks.tender.keys()].some((field) => !assignedTender.has(field)) ||
    assigned.supplier.size !== checks.supplier.size
  ) {
    throw new Error("RAG query annotations do not assign every scored extraction field.");
  }
  const operations = (["general", "compliance", "supplier"] as const).map((group) => {
    const documentId = group === "supplier" ? supplierPdf.documentId : tenderPdf.documentId;
    const fieldMap = resolved.get(documentId)!;
    const checkMap = group === "supplier" ? checks.supplier : checks.tender;
    const selected = groups[group];
    const fields = [...assigned[group]].map((field) => {
      const evidence = fieldMap.get(field)!;
      const check = checkMap.get(field)!;
      const evidenceAvailable = available(evidence, selected);
      return {
        field,
        evidenceState: evidence.state,
        evidenceAvailable,
        supportingPassages: evidence.alternatives,
        expected: check.expected,
        actual: check.actual,
        valueMatches: check.valueMatches,
        extractionMatches: check.matches,
        evidenceStatus: check.evidenceStatus,
        observation:
          evidenceAvailable === null
            ? "source_does_not_state_field"
            : evidenceAvailable
              ? check.matches
                ? "evidence_available_value_matches"
                : "evidence_available_extraction_or_validation_gap"
              : check.matches
                ? "value_matches_without_annotated_context"
                : "evidence_missing_cause_unproven",
      };
    });
    return {
      group,
      documentId,
      suppliedChunks: [...selected]
        .sort((a, b) => a - b)
        .map((index) => ({
          documentId,
          pageNumber: chunks.get(documentId)![index]!.pageNumber,
          chunkIndex: index,
        })),
      coverage: coverage(fields),
      fields,
    };
  });
  const total = operations.reduce((sum, operation) => sum + operation.coverage.total, 0);
  const covered = operations.reduce((sum, operation) => sum + operation.coverage.covered, 0);
  return {
    schemaVersion: 1,
    supplierId: supplierPdf.documentId,
    rankingSource: "saved_query_chunk_order",
    supportedK: [1, 2],
    sourceVerification: {
      chunkerVersion: CHUNKER_VERSION,
      documents: [tenderPdf, supplierPdf].map((pdf) => ({
        documentId: pdf.documentId,
        contentSha256: documentContentHash(pdf),
        chunkCount: chunks.get(pdf.documentId)!.length,
      })),
    },
    queries: queryResults,
    operations,
    overallCoverage: { covered, total, ratio: total ? covered / total : null },
    extractionAccuracy: extraction.combinedAccuracy,
  };
}
