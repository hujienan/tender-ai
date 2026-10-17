import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateAssessment, evaluateExtraction } from "../packages/evaluation/src/evaluate.ts";
import {
  SupplierExtractionSchema,
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = process.argv[2] ?? join(root, "tmp/extractions/voltline.json");
const LegacyReportSchema = z.object({
  documentId: z.string(),
  extracted: SupplierExtractionSchema.nullable(),
  validation: z.object({ valid: z.boolean() }),
});
const AssessmentSchema = z.object({
  version: z.enum(["2c", "2d"]),
  tender: z.object({
    extracted: TenderRequirementsSchema.nullable(),
    validation: z.object({ valid: z.boolean() }).passthrough(),
  }),
  supplier: z.object({
    documentId: z.string(),
    extracted: SupplierFactsSchema.nullable(),
    validation: z.object({ valid: z.boolean() }).passthrough(),
  }),
  assessment: z.object({
    status: z.string(),
    findings: z.array(z.object({ type: z.string() })),
  }),
});

try {
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  const result =
    saved &&
    typeof saved === "object" &&
    "version" in saved &&
    (saved.version === "2c" || saved.version === "2d")
      ? evaluateAssessment(AssessmentSchema.parse(saved), reference)
      : evaluateExtraction(LegacyReportSchema.parse(saved), reference);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
}
