import { Pool } from "pg";
import type { DocumentStore, IndexedChunk, IndexedDocument } from "./index.ts";

export class PostgresDocumentStore implements DocumentStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  static connect(connectionString: string): PostgresDocumentStore {
    return new PostgresDocumentStore(new Pool({ connectionString }));
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

  async replaceDocument(document: IndexedDocument, chunks: IndexedChunk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO source_documents
          (document_id, source_name, content_sha256, page_count, chunker_version,
           embedding_model_id, embedding_region, embedding_dimensions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (document_id) DO UPDATE SET
           source_name = EXCLUDED.source_name,
           content_sha256 = EXCLUDED.content_sha256,
           page_count = EXCLUDED.page_count,
           chunker_version = EXCLUDED.chunker_version,
           embedding_model_id = EXCLUDED.embedding_model_id,
           embedding_region = EXCLUDED.embedding_region,
           embedding_dimensions = EXCLUDED.embedding_dimensions,
           updated_at = now()`,
        [
          document.documentId,
          document.sourceName,
          document.contentSha256,
          document.pageCount,
          document.chunkerVersion,
          document.embeddingModelId,
          document.embeddingRegion,
          document.embeddingDimensions,
        ],
      );
      await client.query("DELETE FROM document_chunks WHERE document_id = $1", [
        document.documentId,
      ]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO document_chunks
            (document_id, chunk_index, page_number, start_offset, end_offset,
             original_text, content_sha256, embedding, embedding_model_id,
             embedding_region, embedding_dimensions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11)`,
          [
            chunk.documentId,
            chunk.chunkIndex,
            chunk.pageNumber,
            chunk.startOffset,
            chunk.endOffset,
            chunk.text,
            chunk.contentSha256,
            `[${chunk.embedding.join(",")}]`,
            document.embeddingModelId,
            document.embeddingRegion,
            document.embeddingDimensions,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Failed to store document ${document.documentId}.`, { cause: error });
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
