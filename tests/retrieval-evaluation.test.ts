import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import extractionReference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import retrievalReference from "../datasets/electrical-installation/retrieval-reference.json" with { type: "json" };
import savedFixture from "./fixtures/retrieval-report.json" with { type: "json" };
import { chunkDocument, documentContentHash } from "../packages/indexing/src/chunk.ts";
import { extractPdf, type ExtractedPdf } from "../packages/pdf/src/extract.ts";
import { evaluateRetrieval } from "../packages/evaluation/src/retrieval.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
type Saved = typeof savedFixture;
let tender: ExtractedPdf;
let supplier: ExtractedPdf;

beforeAll(async () => {
  tender = await extractPdf(
    join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
    "tender",
  );
  supplier = await extractPdf(
    join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
    "voltline",
  );
});

const evaluate = (
  saved: unknown = savedFixture,
  labels: unknown = retrievalReference,
  tenderPdf = tender,
) => evaluateRetrieval(saved, extractionReference, labels, tenderPdf, supplier);
const clone = (): Saved => structuredClone(savedFixture);
const summarized = () => {
  const saved = clone();
  return {
    ...saved,
    retrieval: {
      ...saved.retrieval,
      groupChunkCounts: { general: 2, compliance: 1, supplier: 3 },
      distinctChunkCount: 5,
      embeddingRequests: 7,
    },
  };
};
const operation = (
  result: ReturnType<typeof evaluate>,
  group: "general" | "compliance" | "supplier",
) => result.operations.find((entry) => entry.group === group)!;
const field = (result: ReturnType<typeof evaluate>, name: string) =>
  result.operations.flatMap((entry) => entry.fields).find((entry) => entry.field === name)!;

describe("offline RAG retrieval evaluation", () => {
  it("accepts matching retrieval summary counts and reports without summary metadata", () => {
    expect(evaluate(summarized()).overallCoverage).toEqual({ covered: 22, total: 22, ratio: 1 });
    expect(evaluate(clone()).overallCoverage).toEqual({ covered: 22, total: 22, ratio: 1 });
    const partial = clone() as Saved & {
      retrieval: Saved["retrieval"] & { embeddingRequests?: number };
    };
    partial.retrieval.embeddingRequests = 7;
    expect(evaluate(partial).overallCoverage.total).toBe(22);
  });

  it("rejects summary counts that contradict the saved query results", () => {
    const group = summarized();
    group.retrieval.groupChunkCounts.compliance = 2;
    expect(() => evaluate(group)).toThrow(/groupChunkCounts.compliance/);

    const distinct = summarized();
    distinct.retrieval.distinctChunkCount = 6;
    expect(() => evaluate(distinct)).toThrow(/distinctChunkCount/);

    const requests = summarized();
    requests.retrieval.embeddingRequests = 8;
    expect(() => evaluate(requests)).toThrow(/embeddingRequests/);
  });

  it("scores complete operation coverage and true rank-one/rank-two chunk recall", () => {
    const result = evaluate();
    expect(result.overallCoverage).toEqual({ covered: 22, total: 22, ratio: 1 });
    expect(operation(result, "general").coverage).toEqual({
      covered: 5,
      total: 5,
      ratio: 1,
      sourceAbsent: 0,
    });
    expect(operation(result, "compliance").coverage).toEqual({
      covered: 3,
      total: 3,
      ratio: 1,
      sourceAbsent: 0,
    });
    expect(operation(result, "supplier").coverage).toEqual({
      covered: 14,
      total: 14,
      ratio: 1,
      sourceAbsent: 1,
    });
    expect(result.queries[0]?.recallAtK).toEqual({
      1: { hits: 0, relevant: 1, value: 0 },
      2: { hits: 1, relevant: 1, value: 1 },
    });
    expect(result.queries[0]?.rankedChunks.map((chunk) => chunk.relevant)).toEqual([false, true]);
    expect(result.sourceVerification.documents.map((document) => document.chunkCount)).toEqual([
      2, 3,
    ]);
  });

  it("reports partial supplier coverage when a relevant page is missing from every supplier query", () => {
    const saved = clone();
    saved.retrieval.queries[4]!.chunks = saved.retrieval.queries[4]!.chunks.slice(0, 1);
    saved.retrieval.queries[5]!.chunks = saved.retrieval.queries[5]!.chunks.slice(0, 1);
    saved.retrieval.queries[6]!.chunks = saved.retrieval.queries[6]!.chunks.slice(0, 1);
    const result = evaluate(saved);
    expect(operation(result, "supplier").coverage).toEqual({
      covered: 13,
      total: 14,
      ratio: 13 / 14,
      sourceAbsent: 1,
    });
    expect(field(result, "insuranceEvidence.workersCompensation.policyId")).toMatchObject({
      evidenceAvailable: false,
      observation: "evidence_missing_cause_unproven",
    });
    expect(result.queries[6]?.recallAtK[2]).toEqual({ hits: 1, relevant: 2, value: 0.5 });
  });

  it("distinguishes zero coverage from source absence", () => {
    const saved = clone();
    saved.retrieval.queries[0]!.chunks = saved.retrieval.queries[0]!.chunks.slice(0, 1);
    saved.retrieval.queries[1]!.chunks = [{ documentId: "tender", pageNumber: 2, chunkIndex: 1 }];
    const result = evaluate(saved);
    expect(operation(result, "general").coverage).toEqual({
      covered: 0,
      total: 5,
      ratio: 0,
      sourceAbsent: 0,
    });
    expect(result.queries[0]?.evidenceHitRate).toEqual({
      covered: 0,
      total: 3,
      ratio: 0,
      sourceAbsent: 0,
    });
    expect(field(result, "insuranceEvidence.publicLiability.status")).toMatchObject({
      evidenceState: "explicit_absence",
      evidenceAvailable: true,
    });
    expect(field(result, "insuranceEvidence.publicLiability.policyId")).toMatchObject({
      evidenceState: "not_stated",
      evidenceAvailable: null,
      expected: null,
    });
    saved.retrieval.queries[0]!.chunks = [];
    saved.retrieval.queries[1]!.chunks = [];
    expect(operation(evaluate(saved), "general").coverage.covered).toBe(0);
  });

  it("deduplicates repeated chunks and combines evidence across queries only at operation level", () => {
    const saved = clone();
    saved.retrieval.queries[4]!.chunks = [
      { documentId: "voltline", pageNumber: 1, chunkIndex: 0 },
      { documentId: "voltline", pageNumber: 1, chunkIndex: 0 },
    ];
    saved.retrieval.queries[5]!.chunks = [{ documentId: "voltline", pageNumber: 1, chunkIndex: 0 }];
    const result = evaluate(saved);
    expect(result.queries[4]?.recallAtK[2]).toEqual({ hits: 1, relevant: 2, value: 0.5 });
    expect(
      result.queries[5]?.fields.find((entry) => entry.field === "programmeCompletionDate")
        ?.evidenceAvailable,
    ).toBe(false);
    expect(field(result, "programmeCompletionDate").evidenceAvailable).toBe(true);
    expect(operation(result, "supplier").suppliedChunks).toHaveLength(3);
  });

  it("accepts alternative insurance-status passages and validates annotations for all suppliers", async () => {
    for (const id of ["voltline", "sparrow", "arcwell"] as const) {
      const saved = clone();
      saved.supplier.documentId = id;
      for (const query of saved.retrieval.queries) {
        if (query.group !== "supplier") continue;
        query.documentIds = [id];
        query.chunks = query.chunks.map((chunk) => ({ ...chunk, documentId: id }));
      }
      saved.retrieval.queries[5]!.chunks = [{ documentId: id, pageNumber: 1, chunkIndex: 0 }];
      saved.retrieval.queries[6]!.chunks = [{ documentId: id, pageNumber: 3, chunkIndex: 2 }];
      const pdf = await extractPdf(
        join(root, `datasets/electrical-installation/pdfs/${id}-proposal.pdf`),
        id,
      );
      const result = evaluateRetrieval(saved, extractionReference, retrievalReference, tender, pdf);
      expect(field(result, "insuranceEvidence.publicLiability.status").evidenceAvailable).toBe(
        true,
      );
      expect(field(result, "insuranceEvidence.workersCompensation.status").evidenceAvailable).toBe(
        true,
      );
      expect(result.supplierId).toBe(id);
    }
  });

  it("requires correct source-document scope and compatible chunk references", () => {
    const wrongRequested = clone();
    wrongRequested.retrieval.queries[0]!.documentIds = ["voltline"];
    expect(() => evaluate(wrongRequested)).toThrow(/wrong source document/);
    const wrongReturned = clone();
    wrongReturned.retrieval.queries[0]!.chunks[0]!.documentId = "voltline";
    expect(() => evaluate(wrongReturned)).toThrow(/stale or incompatible chunk provenance/);
    const badHash = clone();
    Object.assign(badHash.retrieval.queries[0]!.chunks[0]!, { contentSha256: "0".repeat(64) });
    expect(() => evaluate(badHash)).toThrow(/stale or incompatible chunk provenance/);
    const changedPdf = structuredClone(tender);
    changedPdf.pages[0]!.text += " Changed after indexing.";
    expect(() => evaluate(savedFixture, retrievalReference, changedPdf)).toThrow(
      /differs from retrieval annotations/,
    );
    const staleLabels = structuredClone(retrievalReference);
    staleLabels.sourceContentSha256.tender = "0".repeat(64);
    expect(() => evaluate(savedFixture, staleLabels)).toThrow(/differs from retrieval annotations/);
  });

  it("rejects missing retrieval metadata, ranking arrays and unsupported report formats", () => {
    const missing = clone() as Partial<Saved>;
    delete missing.retrieval;
    expect(() => evaluate(missing)).toThrow();
    const unranked = clone();
    delete (unranked.retrieval.queries[0] as Record<string, unknown>).chunks;
    expect(() => evaluate(unranked)).toThrow();
    const unnamed = clone();
    delete (unnamed.retrieval.queries[0] as Record<string, unknown>).query;
    expect(() => evaluate(unnamed)).toThrow();
    const full = clone();
    full.mode = "full" as "rag";
    expect(() => evaluate(full)).toThrow(/Full-document reports/);
    const obsolete = clone();
    obsolete.schemaVersion = 2 as 1;
    expect(() => evaluate(obsolete)).toThrow();
    const incompleteLabels = structuredClone(retrievalReference);
    delete (incompleteLabels.fields.voltline as Record<string, unknown>).supplierName;
    expect(() => evaluate(savedFixture, incompleteLabels)).toThrow(/every scored field/);
    const mislabeledAbsence = structuredClone(retrievalReference);
    (mislabeledAbsence.fields.voltline as Record<string, unknown>).supplierName = {
      state: "not_stated",
      reason: "Incorrect annotation",
    };
    expect(() => evaluate(savedFixture, mislabeledAbsence)).toThrow(/Only expected null fields/);
  });

  it("requires both chunks when a supporting quotation spans a chunk boundary", () => {
    const quote = "Tender ID: NQTC-ELEC-2026-01.";
    let splitTender: ExtractedPdf | undefined;
    let spanning: number[] = [];
    for (let words = 450; words < 620; words++) {
      const candidate = structuredClone(tender);
      candidate.pages[0]!.text = "X ".repeat(words) + candidate.pages[0]!.text;
      const start = candidate.pages[0]!.text.indexOf(quote);
      const indexes = chunkDocument(candidate)
        .filter(
          (chunk) =>
            chunk.pageNumber === 1 &&
            chunk.startOffset < start + quote.length &&
            chunk.endOffset > start,
        )
        .map((chunk) => chunk.chunkIndex);
      if (indexes.length === 2) {
        splitTender = candidate;
        spanning = indexes;
        break;
      }
    }
    expect(splitTender).toBeDefined();
    const labels = structuredClone(retrievalReference);
    labels.sourceContentSha256.tender = documentContentHash(splitTender!);
    const saved = clone();
    const chunks = chunkDocument(splitTender!);
    const pageOne = chunks.filter((chunk) => chunk.pageNumber === 1);
    const pageTwo = chunks.find((chunk) => chunk.pageNumber === 2)!;
    for (const query of saved.retrieval.queries) {
      if (query.group === "general") {
        query.chunks = pageOne.map((chunk) => ({
          documentId: "tender",
          pageNumber: 1,
          chunkIndex: chunk.chunkIndex,
        }));
      } else if (query.group === "compliance") {
        query.chunks = [{ documentId: "tender", pageNumber: 2, chunkIndex: pageTwo.chunkIndex }];
      }
    }
    expect(spanning).toHaveLength(2);
    expect(field(evaluate(saved, labels, splitTender), "tenderId").evidenceAvailable).toBe(true);
    saved.retrieval.queries[0]!.chunks = saved.retrieval.queries[0]!.chunks.slice(0, 1);
    saved.retrieval.queries[1]!.chunks = saved.retrieval.queries[1]!.chunks.slice(0, 1);
    expect(field(evaluate(saved, labels, splitTender), "tenderId").evidenceAvailable).toBe(false);
  });

  it("supports saved files and stdin without AWS or PostgreSQL", () => {
    const script = join(root, "scripts/evaluate-retrieval.ts");
    for (const [argument, input] of [
      [join(root, "tests/fixtures/retrieval-report.json"), undefined],
      ["-", JSON.stringify(savedFixture)],
    ] as const) {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", script, argument], {
        input,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).overallCoverage).toEqual({
        covered: 22,
        total: 22,
        ratio: 1,
      });
    }
    const full = clone();
    full.mode = "full" as "rag";
    const rejected = spawnSync(process.execPath, ["--experimental-strip-types", script, "-"], {
      input: JSON.stringify(full),
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Only saved RAG reports");
  });
});
