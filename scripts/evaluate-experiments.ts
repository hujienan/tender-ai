import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import retrievalReference from "../datasets/electrical-installation/retrieval-reference.json" with { type: "json" };
import {
  evaluateExperiments,
  ExperimentManifestSchema,
} from "../packages/evaluation/src/experiments.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const manifestPath = process.argv[2];
if (!manifestPath || process.argv.length !== 3) {
  console.error("Usage: pnpm evaluate:experiments <experiment.json>");
  process.exitCode = 1;
} else {
  try {
    const manifest = ExperimentManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    if (new Set(manifest.runs.map((run) => run.runId)).size !== manifest.runs.length) {
      throw new Error("Experiment manifest contains duplicate run IDs.");
    }
    const entries: Parameters<typeof evaluateExperiments>[1][number][] = [];
    const seenPaths = new Map<string, string>();
    for (const run of manifest.runs) {
      const path = resolve(dirname(manifestPath), run.report);
      let canonical: string;
      let report: unknown;
      try {
        canonical = await realpath(path);
        report = JSON.parse(await readFile(canonical, "utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Run ${run.runId}: cannot read report ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const previous = seenPaths.get(canonical);
      if (previous)
        throw new Error(`Run ${run.runId}: report path duplicates run ${previous}: ${canonical}.`);
      seenPaths.set(canonical, run.runId);
      entries.push({ ...run, report });
    }
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tender = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    const suppliers = Object.fromEntries(
      await Promise.all(
        reference.suppliers.map(
          async (supplier) =>
            [
              supplier.documentId,
              await extractPdf(
                join(
                  root,
                  "datasets/electrical-installation/pdfs",
                  `${supplier.documentId}-proposal.pdf`,
                ),
                supplier.documentId,
              ),
            ] as const,
        ),
      ),
    );
    console.log(
      JSON.stringify(
        evaluateExperiments(manifest.experimentId, entries, reference, retrievalReference, {
          tender,
          suppliers,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Experiment evaluation failed.");
    process.exitCode = 1;
  }
}
