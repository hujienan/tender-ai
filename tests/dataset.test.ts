import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import dataset from "../datasets/electrical-installation/reference.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const documentById = new Map(dataset.documents.map((document) => [document.id, document]));

describe("synthetic electrical tender", () => {
  it("has five distinct criteria weighted to 100% and three distinct offers", () => {
    expect(dataset.criteria).toHaveLength(5);
    expect(new Set(dataset.criteria.map((criterion) => criterion.id)).size).toBe(5);
    expect(dataset.criteria.reduce((total, criterion) => total + criterion.weight, 0)).toBe(100);
    expect(dataset.suppliers).toHaveLength(3);
    expect(new Set(dataset.suppliers.map((supplier) => supplier.id)).size).toBe(3);
    expect(dataset.documents).toHaveLength(4);
  });

  it("has distinct prices, durations and warranties with cited qualifications", () => {
    for (const field of ["priceExGstAud", "durationWeeks", "warrantyMonths"] as const) {
      const values = dataset.suppliers.map(
        (supplier) =>
          dataset.answers.find((answer) => answer.subject === supplier.id && answer.field === field)
            ?.value,
      );
      expect(values.every((value) => typeof value === "number" && value > 0)).toBe(true);
      expect(new Set(values).size).toBe(3);
    }
    for (const supplier of dataset.suppliers) {
      expect(documentById.has(supplier.documentId)).toBe(true);
      expect(
        dataset.answers.some(
          (answer) => answer.subject === supplier.id && answer.field === "contractorLicence",
        ),
      ).toBe(true);
      expect(
        dataset.answers.some(
          (answer) => answer.subject === supplier.id && answer.field === "supervisorQualification",
        ),
      ).toBe(true);
      expect(
        dataset.answers.some(
          (answer) => answer.subject === supplier.id && answer.field === "comparableReferences",
        ),
      ).toBe(true);
      expect(
        dataset.answers.some(
          (answer) =>
            answer.subject === supplier.id && answer.field === "publicLiabilityCertificate",
        ),
      ).toBe(true);
    }
    expect(
      new Set(
        dataset.answers
          .filter((answer) => answer.field === "supervisorQualification")
          .map((answer) => answer.value),
      ).size,
    ).toBe(3);
    expect(new Set(dataset.answers.map((answer) => answer.id)).size).toBe(dataset.answers.length);
  });

  it("keeps explicit extraction answers aligned with the synthetic source text and cited answers", () => {
    const expected = dataset.expectedExtraction;
    const answer = (id: string) => dataset.answers.find((entry) => entry.id === id)?.value;
    const tenderText = documentById
      .get("tender")!
      .pages.flatMap((page) => page.lines)
      .join(" ");
    expect(tenderText).toContain(expected.tender.tenderId);
    expect(expected.tender.closingDate).toBe(answer("tender.close"));
    expect(expected.tender.siteAccessDate).toBe(answer("tender.access"));
    expect(expected.tender.requiredPracticalCompletionDate).toBe(answer("tender.completion"));
    expect(tenderText).toContain(`ex-GST lump sum in ${expected.tender.requiredCurrency}`);
    expect(expected.tender.minimumComparableReferences).toBe(2);
    expect(expected.tender.publicLiabilityCertificateRequired).toBe(true);
    expect(expected.tender.workersCompensationCertificateRequired).toBe(true);

    for (const supplier of dataset.suppliers) {
      const values = expected.suppliers[supplier.id as keyof typeof expected.suppliers];
      const sourceText = documentById
        .get(supplier.id)!
        .pages.flatMap((page) => page.lines)
        .join(" ");
      expect(sourceText).toContain(values.supplierName);
      expect(values.currency).toBe(expected.tender.requiredCurrency);
      expect(values.priceExGst).toBe(answer(`${supplier.id}.price`));
      expect(values.proposedDurationWeeks).toBe(answer(`${supplier.id}.duration`));
      expect(values.programmeCompletionDate).toBe(answer(`${supplier.id}.programmeCompletion`));
      expect(values.commercialCompletionDate).toBe(
        answer(`${supplier.id}.commercialCompletion`) ?? null,
      );
      expect(values.warranty.months).toBe(answer(`${supplier.id}.warranty`));
      expect(sourceText).toContain(values.warranty.conditions);
      expect(values.contractorLicence).toBe(answer(`${supplier.id}.licence`));
      expect(values.supervisorQualification).toContain(
        String(answer(`${supplier.id}.supervisorQualification`)),
      );
      expect(values.comparableReferences).toHaveLength(Number(answer(`${supplier.id}.references`)));
      for (const project of values.comparableReferences) expect(sourceText).toContain(project);
      for (const insurance of Object.values(values.insuranceEvidence)) {
        if (insurance.policyId) expect(sourceText).toContain(insurance.policyId);
      }
      expect(sourceText).toContain(
        values.insuranceEvidence.publicLiability.status === "explicitly_missing"
          ? "certificate not attached"
          : "Public liability certificate: attached",
      );
      expect(sourceText).toContain("Workers compensation certificate: attached");
    }
  });

  it("keeps the planned dates consistent with each stated duration", () => {
    const access = dataset.answers.find((answer) => answer.id === "tender.access")?.value;
    if (typeof access !== "string") throw new Error("Missing site access date");
    for (const supplier of dataset.suppliers) {
      const duration = dataset.answers.find(
        (answer) => answer.id === `${supplier.id}.duration`,
      )?.value;
      const completion = dataset.answers.find(
        (answer) => answer.id === `${supplier.id}.programmeCompletion`,
      )?.value;
      if (typeof duration !== "number" || typeof completion !== "string") {
        throw new Error(`Missing programme facts for ${supplier.id}`);
      }
      expect(Date.parse(completion) - Date.parse(access)).toBe(duration * 7 * 24 * 60 * 60 * 1000);
    }
    expect(
      dataset.answers.find((answer) => answer.id === "voltline.commercialCompletion")?.value,
    ).not.toBe(
      dataset.answers.find((answer) => answer.id === "voltline.programmeCompletion")?.value,
    );
  });

  it("locates every reference answer and issue quote on the stated PDF page", async () => {
    const pageText = new Map<string, string>();
    for (const document of dataset.documents) {
      const file = join(root, "datasets/electrical-installation", document.file);
      const task = getDocument({
        data: new Uint8Array(await readFile(file)),
        standardFontDataUrl: new URL(
          "./standard_fonts/",
          import.meta.resolve("pdfjs-dist/package.json"),
        ).href,
        stopAtErrors: true,
      });
      const pdf = await task.promise;
      expect(pdf.numPages).toBe(document.pages.length);
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ");
        pageText.set(`${document.id}:${pageNumber}`, text);
        expect(text).toContain(document.pages[pageNumber - 1]?.heading);
        expect(text).toContain(`Page ${pageNumber} of ${pdf.numPages}`);
        for (const line of document.pages[pageNumber - 1]?.lines ?? [])
          expect(text).toContain(line);
      }
      await task.destroy();
    }

    const sources = [
      ...dataset.criteria.map((criterion) => criterion.source),
      ...dataset.answers.map((answer) => answer.source),
      ...dataset.issues.flatMap((issue) => issue.sources),
    ];
    for (const source of sources) {
      expect(pageText.get(`${source.documentId}:${source.page}`), JSON.stringify(source)).toContain(
        source.quote,
      );
    }
    for (const answer of dataset.answers) {
      expect(answer.source.documentId).toBe(answer.subject);
      if (["priceExGstAud", "durationWeeks", "warrantyMonths"].includes(answer.field)) {
        expect(answer.source.quote).toContain(Number(answer.value).toLocaleString("en-AU"));
      }
      if (
        ["contractorLicence", "supervisorQualification", "publicLiabilityCertificate"].includes(
          answer.field,
        )
      ) {
        expect(answer.source.quote).toContain(String(answer.value));
      }
      if (typeof answer.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(answer.value)) {
        const date = new Intl.DateTimeFormat("en-AU", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(answer.value));
        expect(answer.source.quote).toContain(date);
      }
    }
  });

  it("records the intended evidence, date, warranty and qualification problems", () => {
    expect(new Set(dataset.issues.map((issue) => issue.type))).toEqual(
      new Set([
        "missing_evidence",
        "conflicting_dates",
        "ambiguous_warranty",
        "late_completion",
        "expired_qualification",
      ]),
    );
    for (const issue of dataset.issues) {
      expect(dataset.suppliers.some((supplier) => supplier.id === issue.subject)).toBe(true);
      expect(issue.sources.length).toBeGreaterThanOrEqual(2);
    }
  });
});
