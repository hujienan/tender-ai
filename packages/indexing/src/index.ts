import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import {
  CHUNKER_VERSION,
  chunkDocument,
  documentContentHash,
  type DocumentChunk,
} from "./chunk.ts";

export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingProvider = {
  modelId: string;
  region: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
};

export type IndexedDocument = {
  documentId: string;
  sourceName: string;
  contentSha256: string;
  pageCount: number;
  chunkerVersion: string;
  embeddingModelId: string;
  embeddingRegion: string;
  embeddingDimensions: number;
};

export type IndexedChunk = DocumentChunk & { embedding: number[] };

export type DocumentStore = {
  getDocument(documentId: string): Promise<IndexedDocument | null>;
  replaceDocument(document: IndexedDocument, chunks: IndexedChunk[]): Promise<void>;
};

export async function indexDocument(
  pdf: ExtractedPdf,
  sourceName: string,
  provider: EmbeddingProvider,
  store: DocumentStore,
): Promise<{ status: "indexed" | "unchanged"; documentId: string; chunkCount: number }> {
  if (!sourceName.trim() || !provider.modelId.trim() || !provider.region.trim()) {
    throw new Error("Source name and embedding model metadata are required.");
  }
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embeddings must have ${EMBEDDING_DIMENSIONS} dimensions.`);
  }
  const chunks = chunkDocument(pdf);
  const document: IndexedDocument = {
    documentId: pdf.documentId,
    sourceName,
    contentSha256: documentContentHash(pdf),
    pageCount: pdf.pages.length,
    chunkerVersion: CHUNKER_VERSION,
    embeddingModelId: provider.modelId,
    embeddingRegion: provider.region,
    embeddingDimensions: provider.dimensions,
  };
  const existing = await store.getDocument(pdf.documentId);
  if (
    existing?.contentSha256 === document.contentSha256 &&
    existing.chunkerVersion === document.chunkerVersion &&
    existing.embeddingModelId === document.embeddingModelId &&
    existing.embeddingRegion === document.embeddingRegion &&
    existing.embeddingDimensions === document.embeddingDimensions
  ) {
    return { status: "unchanged", documentId: pdf.documentId, chunkCount: chunks.length };
  }

  const indexed: IndexedChunk[] = [];
  for (const chunk of chunks) {
    let embedding: number[];
    try {
      embedding = await provider.embed(chunk.text);
    } catch (error) {
      throw new Error(`Embedding failed for ${pdf.documentId} chunk ${chunk.chunkIndex}.`, {
        cause: error,
      });
    }
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`Invalid embedding for ${pdf.documentId} chunk ${chunk.chunkIndex}.`);
    }
    indexed.push({ ...chunk, embedding });
  }
  await store.replaceDocument(document, indexed);
  return { status: "indexed", documentId: pdf.documentId, chunkCount: indexed.length };
}
