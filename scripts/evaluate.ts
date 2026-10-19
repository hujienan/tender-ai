import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateAssessment } from "../packages/evaluation/src/evaluate.ts";
import {
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";

const file = process.argv[2];
const recovery = z
  .object({ fieldErrors: z.record(z.string(), z.array(z.string())).optional() })
  .passthrough();
const validation = z
  .object({
    valid: z.boolean(),
    fields: z
      .record(
        z.string(),
        z.object({ status: z.string(), errors: z.array(z.string()).optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();
const group = z.object({ extracted: z.unknown(), recovery: recovery.optional() }).passthrough();
const AssessmentSchema = z.object({
  schemaVersion: z.literal(1),
  tender: z.object({
    extracted: TenderRequirementsSchema.nullable(),
    validation,
    groups: z.object({ general: group, compliance: group }).optional(),
  }),
  supplier: z.object({
    documentId: z.string(),
    extracted: SupplierFactsSchema.nullable(),
    validation,
    recovery: recovery.optional(),
  }),
  assessment: z.object({
    status: z.string(),
    findings: z.array(z.object({ type: z.string() })),
  }),
});

if (!file || process.argv.length > 3) {
  console.error("Usage: pnpm evaluate <saved-report|->");
  process.exitCode = 1;
} else {
  try {
    const saved: unknown = JSON.parse(
      file === "-" ? readFileSync(0, "utf8") : await readFile(file, "utf8"),
    );
    console.log(
      JSON.stringify(evaluateAssessment(AssessmentSchema.parse(saved), reference), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation failed.");
    process.exitCode = 1;
  }
}
