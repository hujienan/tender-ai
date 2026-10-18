import { CHUNKER_VERSION, chunkDocument, documentContentHash } from "../../indexing/src/chunk.ts";
import type { DocumentStore, EmbeddingProvider } from "../../indexing/src/index.ts";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import {
  searchDocuments,
  type RetrievalResult,
  type RetrievalStore,
} from "../../retrieval/src/search.ts";

export type AssessmentRetrievalStore = RetrievalStore & Pick<DocumentStore, "getDocument">;

const TOP_K = 2;
const queries = {
  general: [
    "Tender ID, closing date and site access date",
    "Required practical completion date and tender currency",
  ],
  compliance: [
    "Public liability and workers compensation insurance certificate requirements",
    "Minimum comparable project references required",
  ],
  supplier: [
    "Supplier name, ex-GST price, currency, duration and commercial completion date",
    "Programme practical completion milestones and warranty conditions",
    "Contractor licence, supervisor qualification, comparable references and insurance certificates policy IDs",
  ],
} as const;

type Group = keyof typeof queries;
type ChunkRef = Pick<RetrievalResult, "documentId" | "pageNumber" | "chunkIndex">;

export async function prepareRetrievalContexts(
  tender: ExtractedPdf,
  supplier: ExtractedPdf,
  provider: EmbeddingProvider,
  store: AssessmentRetrievalStore,
) {
  if (tender.documentId === supplier.documentId) {
    throw new Error("Tender and supplier must have different document IDs.");
  }
  const documents = [tender, supplier];
  const indexed = await Promise.all(
    documents.map((document) => store.getDocument(document.documentId)),
  );
  for (const [index, document] of documents.entries()) {
    const metadata = indexed[index];
    if (!metadata)
      throw new Error(
        "Document " + document.documentId + " is not indexed; reindex it before RAG assessment.",
      );
    if (
      metadata.contentSha256 !== documentContentHash(document) ||
      metadata.pageCount !== document.pages.length ||
      metadata.chunkerVersion !== CHUNKER_VERSION
    ) {
      throw new Error(
        "Document " +
          document.documentId +
          " has changed since indexing; reindex it before RAG assessment.",
      );
    }
    if (
      metadata.embeddingModelId !== provider.modelId ||
      metadata.embeddingRegion !== provider.region ||
      metadata.embeddingDimensions !== provider.dimensions
    ) {
      throw new Error(
        "Document " +
          document.documentId +
          " has incompatible embeddings; reindex it before RAG assessment.",
      );
    }
  }
  await store.assertIndexed(
    documents.map((document) => document.documentId),
    provider,
  );

  const contexts = {} as Record<Group, string>;
  const queryDiagnostics: {
    group: Group;
    query: string;
    documentIds: string[];
    chunks: ChunkRef[];
  }[] = [];
  const included = new Set<string>();
  const groupChunkCounts = {} as Record<Group, number>;
  for (const group of ["general", "compliance", "supplier"] as const) {
    const document = group === "supplier" ? supplier : tender;
    const expected = new Map(chunkDocument(document).map((chunk) => [chunk.chunkIndex, chunk]));
    const selected = new Map<string, RetrievalResult>();
    for (const query of queries[group]) {
      const results = await searchDocuments(query, [document.documentId], TOP_K, provider, store);
      for (const result of results) {
        const original = expected.get(result.chunkIndex);
        if (
          result.documentId !== document.documentId ||
          !original ||
          result.pageNumber !== original.pageNumber ||
          result.startOffset !== original.startOffset ||
          result.endOffset !== original.endOffset ||
          result.contentSha256 !== original.contentSha256 ||
          result.originalText !== original.text
        ) {
          throw new Error(
            "Retrieved passage for " +
              document.documentId +
              " differs from the source PDF; reindex before RAG assessment.",
          );
        }
        selected.set(result.documentId + ":" + result.chunkIndex, result);
      }
      queryDiagnostics.push({
        group,
        query,
        documentIds: [document.documentId],
        chunks: results.map(({ documentId, pageNumber, chunkIndex }) => ({
          documentId,
          pageNumber,
          chunkIndex,
        })),
      });
    }
    if (selected.size === 0)
      throw new Error("No retrieved passages for " + group + "; RAG assessment stopped.");
    const passages = [...selected.values()].sort(
      (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex,
    );
    contexts[group] = [
      "Document ID: " + document.documentId,
      ...passages.map(
        (passage) =>
          "[Page " +
          passage.pageNumber +
          ", Chunk " +
          passage.chunkIndex +
          "]\n" +
          passage.originalText,
      ),
    ].join("\n\n");
    groupChunkCounts[group] = passages.length;
    for (const passage of passages) included.add(passage.documentId + ":" + passage.chunkIndex);
  }
  return {
    contexts,
    diagnostics: {
      queries: queryDiagnostics,
      distinctChunkCount: included.size,
      groupChunkCounts,
      embeddingRequests: queryDiagnostics.length,
    },
  };
}
