import { spawnSync } from "node:child_process";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "../packages/indexing/src/index.ts";
import { TITAN_EMBEDDING_MODEL_ID } from "../packages/indexing/src/titan.ts";
import { PostgresRetrievalStore } from "../packages/retrieval/src/postgres.ts";
import { searchDocuments, type RetrievalStore } from "../packages/retrieval/src/search.ts";

const vector = () => Array<number>(EMBEDDING_DIMENSIONS).fill(0.25);
const embedding = {
  modelId: TITAN_EMBEDDING_MODEL_ID,
  region: "ap-southeast-2",
  dimensions: EMBEDDING_DIMENSIONS,
};
const passage = (documentId: string, distance: number) => ({
  documentId,
  sourceName: `${documentId}-proposal.pdf`,
  pageNumber: 3,
  chunkIndex: 2,
  originalText: "Public liability certificate is attached.",
  startOffset: 25,
  endOffset: 66,
  contentSha256: "a".repeat(64),
  distance,
});

function provider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return { ...embedding, embed: vi.fn().mockResolvedValue(vector()) };
}

function store() {
  return {
    assertIndexed: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  } satisfies RetrievalStore;
}

describe("semantic retrieval", () => {
  it("reads stored document freshness metadata by parameterized ID", async () => {
    const document = {
      documentId: "voltline",
      sourceName: "voltline-proposal.pdf",
      contentSha256: "a".repeat(64),
      pageCount: 3,
      chunkerVersion: "page-text-v1-1200",
      embeddingModelId: embedding.modelId,
      embeddingRegion: embedding.region,
      embeddingDimensions: embedding.dimensions,
    };
    const query = vi.fn().mockResolvedValue({ rows: [document] });
    const database = new PostgresRetrievalStore({ query } as unknown as Pool);
    expect(await database.getDocument("voltline")).toEqual(document);
    expect(query.mock.calls[0]?.[0]).toContain("FROM source_documents WHERE document_id = $1");
    expect(query.mock.calls[0]?.[1]).toEqual(["voltline"]);
  });

  it("embeds the query, passes allowlisted documents and topK, and ranks original passages", async () => {
    const model = provider();
    const database = store();
    database.search.mockResolvedValue([passage("voltline", 0.12), passage("tender", 0.38)]);
    const results = await searchDocuments(
      "  liability certificate  ",
      ["voltline", "tender", "voltline"],
      2,
      model,
      database,
    );
    expect(database.assertIndexed).toHaveBeenCalledWith(["voltline", "tender"], model);
    expect(model.embed).toHaveBeenCalledOnce();
    expect(model.embed).toHaveBeenCalledWith("liability certificate");
    expect(database.search).toHaveBeenCalledWith(["voltline", "tender"], model, vector(), 2);
    expect(results).toEqual([
      { ...passage("voltline", 0.12), rank: 1 },
      { ...passage("tender", 0.38), rank: 2 },
    ]);
  });

  it("returns no passages when the filtered vector search has no matches", async () => {
    expect(await searchDocuments("insurance", ["voltline"], 3, provider(), store())).toEqual([]);
  });

  it.each([
    ["", ["voltline"], 3],
    ["insurance", [], 3],
    ["insurance", ["  "], 3],
    ["insurance", [" voltline"], 3],
    ["insurance", ["voltline"], 0],
    ["insurance", ["voltline"], 51],
    ["insurance", ["voltline"], 1.5],
  ])("rejects invalid inputs before any database or embedding call", async (query, ids, topK) => {
    const model = provider();
    const database = store();
    await expect(searchDocuments(query, ids, topK, model, database)).rejects.toThrow();
    expect(model.embed).not.toHaveBeenCalled();
    expect(database.assertIndexed).not.toHaveBeenCalled();
  });

  it("rejects an incompatible embedding provider before searching", async () => {
    const model = { ...provider(), modelId: "mock:offline-smoke" };
    const database = store();
    await expect(searchDocuments("insurance", ["voltline"], 3, model, database)).rejects.toThrow(
      "configured Titan V2",
    );
    expect(database.assertIndexed).not.toHaveBeenCalled();
  });

  it.each([[[1, 2]], [[...vector().slice(1), Number.NaN]], [[...vector().slice(1), Infinity]]])(
    "rejects malformed query embeddings without searching",
    async (badVector) => {
      const model = provider();
      model.embed.mockResolvedValue(badVector);
      const database = store();
      await expect(searchDocuments("insurance", ["voltline"], 3, model, database)).rejects.toThrow(
        "1024 finite numbers",
      );
      expect(database.search).not.toHaveBeenCalled();
    },
  );

  it("preserves provider and database failures", async () => {
    const model = provider();
    const database = store();
    model.embed.mockRejectedValueOnce(new Error("Bedrock unavailable"));
    await expect(searchDocuments("insurance", ["voltline"], 3, model, database)).rejects.toThrow(
      "Query embedding failed",
    );
    database.assertIndexed.mockRejectedValueOnce(new Error("PostgreSQL unavailable"));
    await expect(searchDocuments("insurance", ["voltline"], 3, model, database)).rejects.toThrow(
      "PostgreSQL unavailable",
    );
    database.search.mockRejectedValueOnce(new Error("Query failed"));
    await expect(searchDocuments("insurance", ["voltline"], 3, model, database)).rejects.toThrow(
      "Query failed",
    );
  });

  it("checks indexing and both tables' metadata, with all search inputs parameterized", async () => {
    const requested = "voltline'; DROP TABLE document_chunks; --";
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            documentId: requested,
            embeddingModelId: embedding.modelId,
            embeddingRegion: embedding.region,
            embeddingDimensions: embedding.dimensions,
            hasCompatibleChunks: true,
          },
          {
            documentId: "tender",
            embeddingModelId: embedding.modelId,
            embeddingRegion: embedding.region,
            embeddingDimensions: embedding.dimensions,
            hasCompatibleChunks: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [passage(requested, 0.2)] });
    const database = new PostgresRetrievalStore({ query } as unknown as Pool);
    const results = await searchDocuments(
      "insurance",
      [requested, "tender"],
      1,
      provider(),
      database,
    );
    expect(results[0]).toEqual({ ...passage(requested, 0.2), rank: 1 });

    const [checkSql, checkParams] = query.mock.calls[0] as [string, unknown[]];
    expect(checkSql).toContain("FROM source_documents d WHERE d.document_id = ANY($1::text[])");
    expect(checkSql).toContain("c.embedding_model_id = $2");
    expect(checkSql).toContain("c.embedding_region = $3");
    expect(checkSql).toContain("c.embedding_dimensions = $4");
    expect(checkSql).not.toContain(requested);
    expect(checkParams).toEqual([[requested, "tender"], embedding.modelId, embedding.region, 1024]);

    const [searchSql, searchParams] = query.mock.calls[1] as [string, unknown[]];
    expect(searchSql).toContain("c.embedding <=> $1::vector");
    expect(searchSql).toContain("c.document_id = ANY($2::text[])");
    for (const [table, prefix] of [
      ["source_documents", "d"],
      ["document_chunks", "c"],
    ]) {
      expect(searchSql).toContain(table);
      expect(searchSql).toContain(`${prefix}.embedding_model_id = $3`);
      expect(searchSql).toContain(`${prefix}.embedding_region = $4`);
      expect(searchSql).toContain(`${prefix}.embedding_dimensions = $5`);
    }
    expect(searchSql).toContain("ORDER BY c.embedding <=> $1::vector");
    expect(searchSql).toContain("LIMIT $6::integer");
    expect(searchSql).not.toContain(requested);
    expect(searchSql).not.toContain("insurance");
    expect(searchParams).toEqual([
      `[${vector().join(",")}]`,
      [requested, "tender"],
      embedding.modelId,
      embedding.region,
      1024,
      1,
    ]);
  });

  it.each([
    [{ rows: [] }, "not indexed"],
    [
      {
        rows: [
          {
            documentId: "voltline",
            embeddingModelId: "mock:offline-smoke",
            embeddingRegion: embedding.region,
            embeddingDimensions: 1024,
            hasCompatibleChunks: true,
          },
        ],
      },
      "no compatible indexed chunks",
    ],
    [
      {
        rows: [
          {
            documentId: "voltline",
            embeddingModelId: embedding.modelId,
            embeddingRegion: embedding.region,
            embeddingDimensions: 1024,
            hasCompatibleChunks: false,
          },
        ],
      },
      "no compatible indexed chunks",
    ],
  ])(
    "rejects unknown, incompatible or unindexed documents before embedding",
    async (answer, message) => {
      const query = vi.fn().mockResolvedValue(answer);
      const model = provider();
      await expect(
        searchDocuments(
          "insurance",
          ["voltline"],
          3,
          model,
          new PostgresRetrievalStore({ query } as unknown as Pool),
        ),
      ).rejects.toThrow(message);
      expect(model.embed).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it("rejects the entire request when one of several documents is missing", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          documentId: "voltline",
          embeddingModelId: embedding.modelId,
          embeddingRegion: embedding.region,
          embeddingDimensions: 1024,
          hasCompatibleChunks: true,
        },
      ],
    });
    const model = provider();
    await expect(
      searchDocuments(
        "insurance",
        ["voltline", "tender"],
        3,
        model,
        new PostgresRetrievalStore({ query } as unknown as Pool),
      ),
    ).rejects.toThrow("Document tender is not indexed");
    expect(model.embed).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects invalid CLI arguments before database or Bedrock access", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("../scripts/retrieve.ts", import.meta.url).pathname,
        "--document",
        "voltline",
        "--query",
        "insurance",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
