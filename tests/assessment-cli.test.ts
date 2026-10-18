import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("canonical assessment CLI", () => {
  it("exposes only the current assessment and offline report commands", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.assess).toBe("node --experimental-strip-types scripts/assess.ts");
    expect(manifest.scripts.revalidate).toBe(
      "node --experimental-strip-types scripts/revalidate.ts",
    );
    expect(manifest.scripts.evaluate).toBe("node --experimental-strip-types scripts/evaluate.ts");
    for (const old of [
      "extract:supplier",
      "extract:2d",
      "extract:2e",
      "revalidate:2d",
      "revalidate:assessment",
      "evaluate:extraction",
      "bedrock:demo",
    ]) {
      expect(manifest.scripts[old]).toBeUndefined();
    }
  });

  it.each([
    ["unknown", "nova-lite"],
    ["voltline", "unknown"],
  ])("rejects unsupported selection without invoking a model", (supplier, model) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(root, "scripts/assess.ts"), supplier, model],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm assess");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["voltline", "nova-lite", "--mode", "rag"],
    ["voltline", "nova-lite", "--mode", "unknown", "--live"],
    ["voltline", "nova-lite", "--live"],
    ["voltline", "nova-lite", "--mode", "rag", "--live", "--unknown"],
  ])("rejects invalid RAG arguments before billable calls", (...args) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(root, "scripts/assess.ts"), ...args],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "postgresql://invalid@127.0.0.1:1/invalid" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm assess");
    expect(result.stdout).toBe("");
  });

  it("requires DATABASE_URL before RAG assessment", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "scripts/assess.ts"),
        "voltline",
        "nova-lite",
        "--mode",
        "rag",
        "--live",
      ],
      { encoding: "utf8", env },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set DATABASE_URL");
    expect(result.stdout).toBe("");
  });
});
