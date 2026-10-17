import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareCompliance } from "../packages/comparison/src/compare.ts";
import {
  validateSupplierFacts,
  validateTenderRequirements,
} from "../packages/extraction/src/evidence.ts";
import {
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = process.argv[2] ?? join(root, "tmp/extractions/voltline-2c.json");
const validation = z.object({ valid: z.boolean(), errors: z.array(z.string()) });
const savedSchema = z
  .object({
    version: z.literal("2c"),
    tender: z
      .object({
        documentId: z.literal("tender"),
        extracted: TenderRequirementsSchema.nullable(),
        validation,
      })
      .passthrough(),
    supplier: z
      .object({
        documentId: z.enum(["voltline", "sparrow", "arcwell"]),
        extracted: SupplierFactsSchema.nullable(),
        validation,
      })
      .passthrough(),
  })
  .passthrough();

try {
  const saved = savedSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const tenderPdf = await extractPdf(
    join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
    "tender",
  );
  const supplierPdf = await extractPdf(
    join(
      root,
      "datasets/electrical-installation/pdfs",
      `${saved.supplier.documentId}-proposal.pdf`,
    ),
    saved.supplier.documentId,
  );
  const tender = {
    ...saved.tender,
    validation: saved.tender.extracted
      ? validateTenderRequirements(saved.tender.extracted, tenderPdf)
      : saved.tender.validation,
  };
  const supplier = {
    ...saved.supplier,
    validation: saved.supplier.extracted
      ? validateSupplierFacts(saved.supplier.extracted, supplierPdf)
      : saved.supplier.validation,
  };
  console.log(
    JSON.stringify(
      { ...saved, tender, supplier, assessment: compareCompliance(tender, supplier) },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Revalidation failed.");
  process.exitCode = 1;
}
