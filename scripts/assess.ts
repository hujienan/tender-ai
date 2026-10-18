import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { BEDROCK_MODEL_ID, NOVA_PRO_MODEL_ID } from "../packages/bedrock/src/client.ts";
import { runTenderAssessment } from "../packages/assessment/src/run.ts";
import { TitanEmbeddingProvider } from "../packages/indexing/src/titan.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import { PostgresRetrievalStore } from "../packages/retrieval/src/postgres.ts";

const args = process.argv.slice(2);
const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
const positional = firstFlag < 0 ? args : args.slice(0, firstFlag);
const flags = firstFlag < 0 ? [] : args.slice(firstFlag);
const supplierId = positional[0] ?? "voltline";
const modelName = positional[1] ?? "nova-lite";
let mode: "full" | "rag" = "full";
let live = false;
let invalid = positional.length > 2;
for (let index = 0; index < flags.length; index++) {
  switch (flags[index]) {
    case "--mode":
      if (mode !== "full" || flags[++index] !== "rag") invalid = true;
      else mode = "rag";
      break;
    case "--live":
      if (live) invalid = true;
      live = true;
      break;
    default:
      invalid = true;
  }
}
const modelId =
  modelName === "nova-lite"
    ? BEDROCK_MODEL_ID
    : modelName === "nova-pro"
      ? NOVA_PRO_MODEL_ID
      : null;
if (
  !["voltline", "sparrow", "arcwell"].includes(supplierId) ||
  !modelId ||
  invalid ||
  (mode === "rag" && !live) ||
  (mode === "full" && live)
) {
  console.error(
    "Usage: pnpm assess [voltline|sparrow|arcwell] [nova-lite|nova-pro] [--mode rag --live]",
  );
  process.exitCode = 1;
} else if (mode === "rag" && !process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the local TenderAI PostgreSQL database for RAG assessment.");
  process.exitCode = 1;
} else {
  let retrievalStore: PostgresRetrievalStore | null = null;
  try {
    const started = performance.now();
    if (mode === "rag") retrievalStore = PostgresRetrievalStore.connect(process.env.DATABASE_URL!);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tender = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    const supplier = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs", supplierId + "-proposal.pdf"),
      supplierId,
    );
    const output = join(
      root,
      "tmp/extractions",
      `${supplierId}-assessment-${mode === "rag" ? "rag-" : ""}${modelName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
    );
    const assessment = await runTenderAssessment(
      tender,
      supplier,
      undefined,
      undefined,
      undefined,
      modelId,
      retrievalStore
        ? { mode: "rag", embeddingProvider: new TitanEmbeddingProvider(), retrievalStore }
        : undefined,
    );
    const report = { ...assessment, endToEndLatencyMs: Math.round(performance.now() - started) };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify(
        {
          schemaVersion: report.schemaVersion,
          mode: report.mode,
          modelId,
          region: report.tender.attempts[0]?.region,
          tenderValidation: report.tender.validation,
          supplierValidation: report.supplier.validation,
          assessment: report.assessment,
          estimatedCostUsd: report.totalEstimatedCostUsd,
          knownEstimatedCostUsd: report.knownEstimatedCostUsd,
          endToEndLatencyMs: report.endToEndLatencyMs,
          ...(report.mode === "rag" ? { retrieval: report.retrieval } : {}),
          attempts: report.tender.attempts.length + report.supplier.attempts.length,
          operations: {
            general: {
              attempts: report.tender.groups.general.attempts.length,
              recovery: report.tender.groups.general.recovery,
            },
            compliance: {
              attempts: report.tender.groups.compliance.attempts.length,
              recovery: report.tender.groups.compliance.recovery,
            },
            supplier: {
              attempts: report.supplier.attempts.length,
              recovery: report.supplier.recovery,
            },
          },
          saved: output,
        },
        null,
        2,
      ),
    );
    if (!report.tender.validation.valid || !report.supplier.validation.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Assessment failed.");
    process.exitCode = 1;
  } finally {
    await retrievalStore?.close();
  }
}
