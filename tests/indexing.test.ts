import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ExtractedPdf } from "../packages/pdf/src/extract.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import { chunkDocument, documentContentHash, sha256 } from "../packages/indexing/src/chunk.ts";
import {
  EMBEDDING_DIMENSIONS,
  indexDocument,
  type DocumentStore,
  type EmbeddingProvider,
  type IndexedChunk,
  type IndexedDocument,
} from "../packages/indexing/src/index.ts";
import { PostgresDocumentStore } from "../packages/indexing/src/postgres.ts";
import {
  TitanEmbeddingProvider,
  TITAN_EMBEDDING_MODEL_ID,
} from "../packages/indexing/src/titan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const vector = () => Array<number>(EMBEDDING_DIMENSIONS).fill(0.25);

class MemoryStore implements DocumentStore {
  documents = new Map<string, IndexedDocument>();
  chunks = new Map<string, IndexedChunk[]>();
  writes = 0;

  async getDocument(id: string) {
    return this.documents.get(id) ?? null;
  }

  async replaceDocument(document: IndexedDocument, chunks: IndexedChunk[]) {
    this.documents.set(document.documentId, document);
    this.chunks.set(document.documentId, chunks);
    this.writes++;
  }
}

function provider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    modelId: TITAN_EMBEDDING_MODEL_ID,
    region: "ap-southeast-2",
    dimensions: EMBEDDING_DIMENSIONS,
    embed: vi.fn().mockImplementation(async () => vector()),
  };
}

describe("document indexing", () => {
  it("splits pages deterministically into exact, ordered source passages", () => {
    const pdf: ExtractedPdf = {
      documentId: "tender",
      pages: [
        { page: 1, text: "Electrical installation scope. ".repeat(90).trimEnd() },
        { page: 2, text: "Insurance certificates required.\nPrice in AUD." },
      ],
    };
    const first = chunkDocument(pdf);
    expect(chunkDocument(pdf)).toEqual(first);
    expect(first.length).toBeGreaterThan(2);
    expect(first.map((chunk) => chunk.chunkIndex)).toEqual(first.map((_, index) => index));
    for (const page of pdf.pages) {
      const pageChunks = first.filter((chunk) => chunk.pageNumber === page.page);
      expect(pageChunks.map((chunk) => chunk.text).join("")).toBe(page.text);
      for (const chunk of pageChunks) {
        expect(chunk.text).toBe(page.text.slice(chunk.startOffset, chunk.endOffset));
        expect(chunk.contentSha256).toBe(sha256(chunk.text));
        expect(chunk.documentId).toBe("tender");
      }
    }
    expect(documentContentHash(pdf)).toBe(documentContentHash(structuredClone(pdf)));
    expect(
      documentContentHash({ ...pdf, pages: [{ page: 1, text: "changed" }, pdf.pages[1]!] }),
    ).not.toBe(documentContentHash(pdf));
    expect(() => chunkDocument({ ...pdf, pages: [{ page: 2, text: "bad" }] })).toThrow("one-based");
  });

  it("keeps synthetic documents isolated and skips all embedding work on repeated ingestion", async () => {
    const dir = join(root, "datasets/electrical-installation/pdfs");
    const [tender, voltline] = await Promise.all([
      extractPdf(join(dir, "tender-request.pdf"), "tender"),
      extractPdf(join(dir, "voltline-proposal.pdf"), "voltline"),
    ]);
    const store = new MemoryStore();
    const embedder = provider();
    const first = await indexDocument(tender, "tender-request.pdf", embedder, store);
    const second = await indexDocument(voltline, "voltline-proposal.pdf", embedder, store);
    expect(first.status).toBe("indexed");
    expect(second.status).toBe("indexed");
    expect(store.documents.size).toBe(2);
    expect(store.chunks.get("tender")?.every((chunk) => chunk.documentId === "tender")).toBe(true);
    expect(store.chunks.get("voltline")?.every((chunk) => chunk.documentId === "voltline")).toBe(
      true,
    );
    expect(store.documents.get("tender")?.embeddingModelId).toBe(TITAN_EMBEDDING_MODEL_ID);
    expect(store.documents.get("tender")?.embeddingDimensions).toBe(1024);
    expect(store.writes).toBe(2);
    const calls = embedder.embed.mock.calls.length;
    expect(await indexDocument(tender, "tender-request.pdf", embedder, store)).toEqual({
      status: "unchanged",
      documentId: "tender",
      chunkCount: first.chunkCount,
    });
    expect(embedder.embed).toHaveBeenCalledTimes(calls);
    expect(store.writes).toBe(2);
    expect(store.chunks.get("tender")?.[0]?.pageNumber).toBe(1);
  });

  it("replaces only changed documents and retains stable IDs", async () => {
    const pdf: ExtractedPdf = {
      documentId: "voltline",
      pages: [{ page: 1, text: "Original proposal." }],
    };
    const store = new MemoryStore();
    const embedder = provider();
    await indexDocument(pdf, "voltline-proposal.pdf", embedder, store);
    const changed = { ...pdf, pages: [{ page: 1, text: "Revised proposal." }] };
    await indexDocument(changed, "voltline-proposal.pdf", embedder, store);
    expect(store.writes).toBe(2);
    expect(store.documents.size).toBe(1);
    expect(store.documents.get("voltline")?.contentSha256).toBe(documentContentHash(changed));
    expect(store.chunks.get("voltline")?.[0]?.text).toBe("Revised proposal.");
    expect(embedder.embed).toHaveBeenCalledTimes(2);
  });

  it("does not write partial results when embedding or vector validation fails", async () => {
    const pdf: ExtractedPdf = {
      documentId: "tender",
      pages: [{ page: 1, text: "A ".repeat(1000) }],
    };
    const store = new MemoryStore();
    const embedder = provider();
    embedder.embed
      .mockResolvedValueOnce(vector())
      .mockRejectedValueOnce(new Error("offline failure"));
    await expect(indexDocument(pdf, "tender-request.pdf", embedder, store)).rejects.toThrow(
      "Embedding failed for tender chunk 1",
    );
    expect(store.writes).toBe(0);
    expect(store.documents.size).toBe(0);
    embedder.embed.mockReset().mockResolvedValue([1, 2]);
    await expect(indexDocument(pdf, "tender-request.pdf", embedder, store)).rejects.toThrow(
      "Invalid embedding",
    );
    expect(store.writes).toBe(0);
  });

  it("propagates storage failures and rolls back a failed PostgreSQL replacement", async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO document_chunks")) throw new Error("disk failure");
      }),
      release,
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const store = new PostgresDocumentStore(pool);
    const pdf: ExtractedPdf = { documentId: "tender", pages: [{ page: 1, text: "Tender text." }] };
    await expect(indexDocument(pdf, "tender-request.pdf", provider(), store)).rejects.toThrow(
      "Failed to store document tender",
    );
    expect(queries[0]).toBe("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("configures Titan V2 without invoking AWS during construction", async () => {
    const embedQuery = vi.fn().mockResolvedValue(vector());
    const titan = new TitanEmbeddingProvider({ embedQuery });
    expect(titan.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(titan.region).toBe("ap-southeast-2");
    expect(titan.dimensions).toBe(1024);
    expect(await titan.embed("A cited construction passage.")).toHaveLength(1024);
    expect(embedQuery).toHaveBeenCalledWith("A cited construction passage.");
  });
});
