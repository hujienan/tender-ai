import { Pool } from "pg";
import type { IndexedDocument } from "../../indexing/src/index.ts";
import type { EmbeddingConfig, RetrievalResult, RetrievalStore } from "./search.ts";

type IndexedRow = {
  documentId: string;
  embeddingModelId: string;
  embeddingRegion: string;
  embeddingDimensions: number;
  hasCompatibleChunks: boolean;
};

export class PostgresRetrievalStore implements RetrievalStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  static connect(connectionString: string): PostgresRetrievalStore {
    return new PostgresRetrievalStore(new Pool({ connectionString }));
  }

  async getDocument(documentId: string): Promise<IndexedDocument | null> {
    const result = await this.pool.query<IndexedDocument>(
      `SELECT document_id AS "documentId", source_name AS "sourceName",
              content_sha256 AS "contentSha256", page_count AS "pageCount",
              chunker_version AS "chunkerVersion", embedding_model_id AS "embeddingModelId",
              embedding_region AS "embeddingRegion", embedding_dimensions AS "embeddingDimensions"
         FROM source_documents WHERE document_id = $1`,
      [documentId],
    );
    return result.rows[0] ?? null;
  }

  async assertIndexed(documentIds: string[], embedding: EmbeddingConfig): Promise<void> {
    const result = await this.pool.query<IndexedRow>(
      `SELECT d.document_id AS "documentId", d.embedding_model_id AS "embeddingModelId",
              d.embedding_region AS "embeddingRegion", d.embedding_dimensions AS "embeddingDimensions",
              EXISTS (
                SELECT 1 FROM document_chunks c
                 WHERE c.document_id = d.document_id
                   AND c.embedding_model_id = $2 AND c.embedding_region = $3
                   AND c.embedding_dimensions = $4
              ) AS "hasCompatibleChunks"
         FROM source_documents d WHERE d.document_id = ANY($1::text[])`,
      [documentIds, embedding.modelId, embedding.region, embedding.dimensions],
    );
    const indexed = new Map(result.rows.map((row) => [row.documentId, row]));
    for (const id of documentIds) {
      const row = indexed.get(id);
      if (!row) throw new Error(`Document ${id} is not indexed.`);
      if (
        row.embeddingModelId !== embedding.modelId ||
        row.embeddingRegion !== embedding.region ||
        row.embeddingDimensions !== embedding.dimensions ||
        !row.hasCompatibleChunks
      ) {
        throw new Error(`Document ${id} has no compatible indexed chunks.`);
      }
    }
  }

  async search(
    documentIds: string[],
    embedding: EmbeddingConfig,
    vector: number[],
    topK: number,
  ): Promise<Omit<RetrievalResult, "rank">[]> {
    const result = await this.pool.query<Omit<RetrievalResult, "rank">>(
      `SELECT c.document_id AS "documentId", d.source_name AS "sourceName",
              c.page_number AS "pageNumber", c.chunk_index AS "chunkIndex",
              c.original_text AS "originalText", c.start_offset AS "startOffset",
              c.end_offset AS "endOffset", c.content_sha256 AS "contentSha256",
              (c.embedding <=> $1::vector)::double precision AS "distance"
         FROM document_chunks c JOIN source_documents d ON d.document_id = c.document_id
        WHERE c.document_id = ANY($2::text[])
          AND d.embedding_model_id = $3 AND c.embedding_model_id = $3
          AND d.embedding_region = $4 AND c.embedding_region = $4
          AND d.embedding_dimensions = $5 AND c.embedding_dimensions = $5
        ORDER BY c.embedding <=> $1::vector, c.document_id, c.chunk_index
        LIMIT $6::integer`,
      [
        `[${vector.join(",")}]`,
        documentIds,
        embedding.modelId,
        embedding.region,
        embedding.dimensions,
        topK,
      ],
    );
    return result.rows;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
