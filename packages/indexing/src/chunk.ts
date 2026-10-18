import { createHash } from "node:crypto";
import type { ExtractedPdf } from "../../pdf/src/extract.ts";

export const CHUNK_MAX_CHARS = 1200;
export const CHUNKER_VERSION = "page-text-v1-1200";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type DocumentChunk = {
  documentId: string;
  chunkIndex: number;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  text: string;
  contentSha256: string;
};

export function chunkDocument(document: ExtractedPdf): DocumentChunk[] {
  if (!document.documentId.trim() || document.pages.length === 0) {
    throw new Error("An identified PDF with at least one page is required.");
  }
  const chunks: DocumentChunk[] = [];
  for (const [index, page] of document.pages.entries()) {
    if (page.page !== index + 1) throw new Error("PDF pages must be consecutive and one-based.");
    if (!page.text.trim()) continue;
    for (let start = 0; start < page.text.length;) {
      let end = Math.min(start + CHUNK_MAX_CHARS, page.text.length);
      if (end < page.text.length) {
        for (let boundary = end - 1; boundary > start + CHUNK_MAX_CHARS / 2; boundary--) {
          if (/\s/u.test(page.text[boundary]!)) {
            end = boundary + 1;
            break;
          }
        }
        const last = page.text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end--;
      }
      const text = page.text.slice(start, end);
      if (!text.trim()) throw new Error(`Page ${page.page} produced a whitespace-only chunk.`);
      chunks.push({
        documentId: document.documentId,
        chunkIndex: chunks.length,
        pageNumber: page.page,
        startOffset: start,
        endOffset: end,
        text,
        contentSha256: sha256(text),
      });
      start = end;
    }
  }
  if (chunks.length === 0) throw new Error("PDF has no indexable text.");
  return chunks;
}

export function documentContentHash(document: ExtractedPdf): string {
  return sha256(JSON.stringify(document.pages.map((page) => [page.page, page.text])));
}
