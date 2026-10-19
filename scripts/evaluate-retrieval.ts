import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import retrievalReference from "../datasets/electrical-installation/retrieval-reference.json" with { type: "json" };
import { evaluateRetrieval } from "../packages/evaluation/src/retrieval.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const file = process.argv[2];
if (!file || process.argv.length > 3) {
  console.error("Usage: pnpm evaluate:retrieval <saved-rag-report|->");
  process.exitCode = 1;
} else {
  try {
    const saved: unknown = JSON.parse(
      file === "-" ? readFileSync(0, "utf8") : await readFile(file, "utf8"),
    );
    if ((saved as { mode?: unknown } | null)?.mode !== "rag") {
      throw new Error("Only saved RAG reports contain retrieval results.");
    }
    const supplierId = (saved as { supplier?: { documentId?: unknown } }).supplier?.documentId;
    if (!reference.suppliers.some((supplier) => supplier.documentId === supplierId)) {
      throw new Error("The saved report has an unknown synthetic supplier document ID.");
    }
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tender = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    const supplier = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs", supplierId + "-proposal.pdf"),
      supplierId as string,
    );
    console.log(
      JSON.stringify(
        evaluateRetrieval(saved, reference, retrievalReference, tender, supplier),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Retrieval evaluation failed.");
    process.exitCode = 1;
  }
}
