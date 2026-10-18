import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEDROCK_MODEL_ID, NOVA_PRO_MODEL_ID } from "../packages/bedrock/src/client.ts";
import { runTenderAssessment } from "../packages/assessment/src/run.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const supplierId = process.argv[2] ?? "voltline";
const modelName = process.argv[3] ?? "nova-lite";
const modelId =
  modelName === "nova-lite"
    ? BEDROCK_MODEL_ID
    : modelName === "nova-pro"
      ? NOVA_PRO_MODEL_ID
      : null;
if (
  !["voltline", "sparrow", "arcwell"].includes(supplierId) ||
  !modelId ||
  process.argv.length > 4
) {
  console.error("Usage: pnpm assess [voltline|sparrow|arcwell] [nova-lite|nova-pro]");
  process.exitCode = 1;
} else {
  try {
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
      `${supplierId}-assessment-${modelName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
    );
    const report = await runTenderAssessment(
      tender,
      supplier,
      undefined,
      undefined,
      undefined,
      modelId,
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify(
        {
          schemaVersion: report.schemaVersion,
          modelId,
          region: report.tender.attempts[0]?.region,
          tenderValidation: report.tender.validation,
          supplierValidation: report.supplier.validation,
          assessment: report.assessment,
          estimatedCostUsd: report.totalEstimatedCostUsd,
          knownEstimatedCostUsd: report.knownEstimatedCostUsd,
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
  }
}
