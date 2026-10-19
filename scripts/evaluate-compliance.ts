import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateCompliance } from "../packages/evaluation/src/compliance.ts";

const files = process.argv.slice(2);
if (files.length === 0 || files.filter((file) => file === "-").length > 1) {
  console.error("Usage: pnpm evaluate:compliance <saved-report...|->");
  process.exitCode = 1;
} else {
  try {
    const reports: unknown[] = await Promise.all(
      files.map(async (file) =>
        JSON.parse(file === "-" ? readFileSync(0, "utf8") : await readFile(file, "utf8")),
      ),
    );
    console.log(JSON.stringify(evaluateCompliance(reports, reference), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Compliance evaluation failed.");
    process.exitCode = 1;
  }
}
