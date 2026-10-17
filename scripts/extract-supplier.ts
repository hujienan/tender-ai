import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAssessment } from "../packages/comparison/src/workflow.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const supplierId = process.argv[2] ?? "voltline";
const suppliers = ["voltline", "sparrow", "arcwell"];
if (!suppliers.includes(supplierId) || process.argv.length > 3) {
  console.error("Usage: pnpm extract:supplier [voltline|sparrow|arcwell]");
  process.exitCode = 1;
} else {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const pdf = join(root, "datasets/electrical-installation/pdfs", `${supplierId}-proposal.pdf`);
    const tenderPdf = join(root, "datasets/electrical-installation/pdfs/tender-request.pdf");
    const output = join(root, "tmp/extractions", `${supplierId}-2c.json`);
    const document = await extractPdf(pdf, supplierId);
    const tender = await extractPdf(tenderPdf, "tender");
    const report = await runAssessment(tender, document);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Saved: ${output}`);
    if (!report.tender.validation.valid || !report.supplier.validation.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Extraction failed.");
    process.exitCode = 1;
  }
}
