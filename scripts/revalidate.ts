import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareValidatedCompliance } from "../packages/comparison/src/compare.ts";
import {
  validateSupplierFields,
  validateTenderFields,
} from "../packages/extraction/src/field-validation.ts";
import {
  GeneralRequirementsSchema,
  ComplianceRequirementsSchema,
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = process.argv[2];
const validation = z.object({ valid: z.boolean(), errors: z.array(z.string()) });
const recovery = z.object({ fieldErrors: z.record(z.string(), z.array(z.string())) }).passthrough();
const savedSchema = z
  .object({
    schemaVersion: z.literal(1),
    tender: z
      .object({
        documentId: z.literal("tender"),
        extracted: TenderRequirementsSchema,
        groups: z.object({
          general: z
            .object({
              extracted: GeneralRequirementsSchema.nullable(),
              validation,
              recovery: recovery.optional(),
            })
            .passthrough(),
          compliance: z
            .object({
              extracted: ComplianceRequirementsSchema.nullable(),
              validation,
              recovery: recovery.optional(),
            })
            .passthrough(),
        }),
      })
      .passthrough(),
    supplier: z
      .object({
        documentId: z.enum(["voltline", "sparrow", "arcwell"]),
        extracted: SupplierFactsSchema.nullable(),
        validation,
        recovery: recovery.optional(),
      })
      .passthrough(),
  })
  .passthrough();

if (!file || process.argv.length > 3) {
  console.error("Usage: pnpm revalidate <saved-report>");
  process.exitCode = 1;
} else
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
      validation: validateTenderFields(saved.tender.extracted, tenderPdf, unavailable, {
        ...saved.tender.groups.general.recovery?.fieldErrors,
        ...saved.tender.groups.compliance.recovery?.fieldErrors,
      }),
    };
    const supplier = {
      ...saved.supplier,
      validation: validateSupplierFields(
        saved.supplier.extracted,
        supplierPdf,
        saved.supplier.extracted ? [] : saved.supplier.validation.errors,
        saved.supplier.recovery?.fieldErrors,
      ),
    };
    console.log(
      JSON.stringify(
        {
          ...saved,
          tender,
          supplier,
          assessment: compareValidatedCompliance(tender, supplier),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Revalidation failed.");
    process.exitCode = 1;
  }
