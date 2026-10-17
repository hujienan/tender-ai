import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareCompliance2D } from "../packages/comparison/src/compare-2d.ts";
import {
  GeneralRequirementsSchema,
  ComplianceRequirementsSchema,
} from "../packages/extraction/src/assessment-2d.ts";
import {
  validateSupplier2D,
  validateTender2D,
} from "../packages/extraction/src/field-validation.ts";
import {
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = process.argv[2] ?? join(root, "tmp/extractions/voltline-2d.json");
const validation = z.object({ valid: z.boolean(), errors: z.array(z.string()) });
const savedSchema = z
  .object({
    version: z.literal("2d"),
    tender: z
      .object({
        documentId: z.literal("tender"),
        extracted: TenderRequirementsSchema,
        groups: z.object({
          general: z
            .object({ extracted: GeneralRequirementsSchema.nullable(), validation })
            .passthrough(),
          compliance: z
            .object({ extracted: ComplianceRequirementsSchema.nullable(), validation })
            .passthrough(),
        }),
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
      saved.supplier.documentId + "-proposal.pdf",
    ),
    saved.supplier.documentId,
  );
  const unavailable = {
    ...(saved.tender.groups.general.extracted
      ? {}
      : { general: saved.tender.groups.general.validation.errors }),
    ...(saved.tender.groups.compliance.extracted
      ? {}
      : { compliance: saved.tender.groups.compliance.validation.errors }),
  };
  const tender = {
    ...saved.tender,
    validation: validateTender2D(saved.tender.extracted, tenderPdf, unavailable),
  };
  const supplier = {
    ...saved.supplier,
    validation: validateSupplier2D(
      saved.supplier.extracted,
      supplierPdf,
      saved.supplier.extracted ? [] : saved.supplier.validation.errors,
    ),
  };
  console.log(
    JSON.stringify(
      {
        ...saved,
        tender,
        supplier,
        assessment: compareCompliance2D(tender, supplier),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Revalidation failed.");
  process.exitCode = 1;
}
