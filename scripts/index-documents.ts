import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexDocument } from "../packages/indexing/src/index.ts";
import { PostgresDocumentStore } from "../packages/indexing/src/postgres.ts";
import { TitanEmbeddingProvider } from "../packages/indexing/src/titan.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const filenames = {
  tender: "tender-request.pdf",
  voltline: "voltline-proposal.pdf",
  sparrow: "sparrow-proposal.pdf",
  arcwell: "arcwell-proposal.pdf",
} as const;
const [flag, ...requested] = process.argv.slice(2);
const connectionString = process.env.DATABASE_URL;
if (
  flag !== "--live" ||
  requested.length === 0 ||
  requested.some((id) => !Object.hasOwn(filenames, id)) ||
  !connectionString
) {
  console.error(
    "Usage: DATABASE_URL=... pnpm index:documents --live tender [voltline|sparrow|arcwell ...] (billable Bedrock embeddings)",
  );
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const store = PostgresDocumentStore.connect(connectionString);
  const provider = new TitanEmbeddingProvider();
  try {
    for (const id of new Set(requested as (keyof typeof filenames)[])) {
      const filename = filenames[id];
      const pdf = await extractPdf(
        join(root, "datasets/electrical-installation/pdfs", filename),
        id,
      );
      const result = await indexDocument(pdf, filename, provider, store);
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Document indexing failed.");
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}
