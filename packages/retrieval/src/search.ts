import { BEDROCK_REGION } from "../../bedrock/src/client.ts";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "../../indexing/src/index.ts";
import { TITAN_EMBEDDING_MODEL_ID } from "../../indexing/src/titan.ts";

export const MAX_TOP_K = 50;

export type RetrievalResult = {
  documentId: string;
  sourceName: string;
  pageNumber: number;
  chunkIndex: number;
  originalText: string;
  startOffset: number;
  endOffset: number;
  contentSha256: string;
  distance: number;
  rank: number;
};

export type EmbeddingConfig = Pick<EmbeddingProvider, "modelId" | "region" | "dimensions">;

export type RetrievalStore = {
  assertIndexed(documentIds: string[], embedding: EmbeddingConfig): Promise<void>;
  search(
    documentIds: string[],
    embedding: EmbeddingConfig,
    vector: number[],
    topK: number,
  ): Promise<Omit<RetrievalResult, "rank">[]>;
};

export async function searchDocuments(
  query: string,
  allowedDocumentIds: string[],
  topK: number,
  provider: EmbeddingProvider,
  store: RetrievalStore,
): Promise<RetrievalResult[]> {
  if (typeof query !== "string" || !query.trim()) throw new Error("A nonempty query is required.");
  if (
    !Array.isArray(allowedDocumentIds) ||
    allowedDocumentIds.length === 0 ||
    allowedDocumentIds.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim())
  ) {
    throw new Error("At least one valid document ID is required.");
  }
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new Error(`topK must be an integer from 1 to ${MAX_TOP_K}.`);
  }
  if (
    provider.modelId !== TITAN_EMBEDDING_MODEL_ID ||
    provider.region !== BEDROCK_REGION ||
    provider.dimensions !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      "Retrieval requires the configured Titan V2 embedding model, region and dimensions.",
    );
  }

  const documentIds = [...new Set(allowedDocumentIds)];
  await store.assertIndexed(documentIds, provider);

  let vector: number[];
  try {
    vector = await provider.embed(query.trim());
  } catch (error) {
    throw new Error("Query embedding failed.", { cause: error });
  }
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSIONS ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(`Query embedding must contain ${EMBEDDING_DIMENSIONS} finite numbers.`);
  }

  const passages = await store.search(documentIds, provider, vector, topK);
  return passages.map((passage, index) => ({ ...passage, rank: index + 1 }));
}
