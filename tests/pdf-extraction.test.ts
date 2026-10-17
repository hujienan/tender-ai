import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("PDF extraction", () => {
  it("preserves the document ID, one-based pages and page text", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    expect(document.documentId).toBe("voltline");
    expect(document.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(document.pages[0]?.text).toContain("Ex-GST lump sum: AUD 1,184,000");
    expect(document.pages[1]?.text).toContain("Programme milestone practical completion");
    expect(document.pages[2]?.text).toContain("Public liability certificate: not included");
  });

  it("reports unreadable and invalid PDFs explicitly", async () => {
    await expect(extractPdf(join(root, "missing.pdf"), "missing")).rejects.toThrow(
      "Cannot read PDF",
    );
    await expect(extractPdf(join(root, "README.md"), "invalid")).rejects.toThrow(
      "Failed to extract PDF",
    );
    await expect(extractPdf("unused.pdf", " ")).rejects.toThrow("document ID");
  });
});
