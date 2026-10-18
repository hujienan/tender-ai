import { PostgresRetrievalStore } from "../packages/retrieval/src/postgres.ts";
import { MAX_TOP_K, searchDocuments } from "../packages/retrieval/src/search.ts";
import { TitanEmbeddingProvider } from "../packages/indexing/src/titan.ts";

const knownDocuments = new Set(["tender", "voltline", "sparrow", "arcwell"]);
const args = process.argv.slice(2);
const documentIds: string[] = [];
let query: string | undefined;
let topK = 5;
let live = false;
let invalid = false;

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  switch (arg) {
    case "--live":
      live = true;
      break;
    case "--document":
      documentIds.push(args[++index] ?? "");
      break;
    case "--query":
      if (query !== undefined) invalid = true;
      query = args[++index];
      break;
    case "--top-k":
      topK = Number(args[++index]);
      break;
    default:
      invalid = true;
  }
}

if (
  invalid ||
  !live ||
  !query?.trim() ||
  documentIds.length === 0 ||
  documentIds.some((id) => !knownDocuments.has(id)) ||
  !Number.isInteger(topK) ||
  topK < 1 ||
  topK > MAX_TOP_K
) {
  console.error(
    `Usage: DATABASE_URL=... pnpm retrieve --live --document tender|voltline|sparrow|arcwell [--document ...] --query "text" [--top-k 1-${MAX_TOP_K}] (billable Titan embedding)`,
  );
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the local TenderAI PostgreSQL database.");
  process.exitCode = 1;
} else {
  const provider = new TitanEmbeddingProvider();
  const store = PostgresRetrievalStore.connect(process.env.DATABASE_URL);
  try {
    const requestedDocumentIds = [...new Set(documentIds)];
    const results = await searchDocuments(query, requestedDocumentIds, topK, provider, store);
    console.log(
      JSON.stringify(
        {
          query,
          documentIds: requestedDocumentIds,
          embeddingModel: {
            modelId: provider.modelId,
            region: provider.region,
            dimensions: provider.dimensions,
          },
          results,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Retrieval failed.");
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}
