import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ExtractedPdf = {
  documentId: string;
  pages: { page: number; text: string }[];
};

export async function extractPdf(file: string, documentId: string): Promise<ExtractedPdf> {
  if (!documentId.trim()) throw new Error("A document ID is required.");

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new Error(`Cannot read PDF: ${file}`, { cause: error });
  }

  let task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: fileURLToPath(
        new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json")),
      ),
      stopAtErrors: true,
    });
    const pdf = await task.promise;
    if (pdf.numPages < 1) throw new Error("PDF has no pages.");
    const pages: ExtractedPdf["pages"] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ page, text });
    }
    if (pages.every((page) => !page.text)) throw new Error("PDF has no extractable text.");
    return { documentId, pages };
  } catch (error) {
    throw new Error(
      `Failed to extract PDF: ${file}: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    );
  } finally {
    await task?.destroy();
  }
}
