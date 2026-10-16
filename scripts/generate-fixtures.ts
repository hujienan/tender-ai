import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import dataset from "../datasets/electrical-installation/reference.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "datasets/electrical-installation");
await mkdir(join(output, "pdfs"), { recursive: true });

for (const document of dataset.documents) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(document.title);
  pdf.setAuthor("TenderAI synthetic fixtures");
  pdf.setCreationDate(new Date("2026-10-16T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-10-16T00:00:00Z"));
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const [index, content] of document.pages.entries()) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText("TENDERAI / SYNTHETIC PROCUREMENT FIXTURE", {
      x: 48,
      y: 790,
      size: 9,
      font: bold,
      color: rgb(0.2, 0.35, 0.5),
    });
    page.drawText(document.title, { x: 48, y: 754, size: 17, font: bold });
    page.drawText(content.heading, { x: 48, y: 720, size: 12, font: bold });

    for (const [lineIndex, line] of content.lines.entries()) {
      if (body.widthOfTextAtSize(line, 10) > 499) {
        throw new Error(`${document.id} page ${index + 1}: line is too wide: ${line}`);
      }
      page.drawText(line, { x: 48, y: 687 - lineIndex * 31, size: 10, font: body });
    }

    page.drawLine({ start: { x: 48, y: 67 }, end: { x: 547, y: 67 }, thickness: 0.7 });
    page.drawText("Fictional data - for software testing only", {
      x: 48,
      y: 48,
      size: 8,
      font: body,
      color: rgb(0.35, 0.35, 0.35),
    });
    page.drawText(`Page ${index + 1} of ${document.pages.length}`, {
      x: 486,
      y: 48,
      size: 8,
      font: body,
    });
  }

  const file = join(output, document.file);
  await writeFile(file, await pdf.save());
  console.log(`Wrote ${file}`);
}
