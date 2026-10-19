import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { evaluateCompliance } from "../packages/evaluation/src/compliance.ts";
import { evaluateAssessment } from "../packages/evaluation/src/evaluate.ts";
import { evaluateRetrieval } from "../packages/evaluation/src/retrieval.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import retrievalReference from "../datasets/electrical-installation/retrieval-reference.json" with { type: "json" };
import voltline from "./fixtures/compliance-voltline.json" with { type: "json" };
import sparrow from "./fixtures/compliance-sparrow.json" with { type: "json" };
import arcwell from "./fixtures/compliance-arcwell.json" with { type: "json" };
import extractionFixture from "./fixtures/evaluation-report.json" with { type: "json" };
import retrievalFixture from "./fixtures/retrieval-report.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const reports = () => structuredClone([voltline, sparrow, arcwell]);
const counts = (result: ReturnType<typeof evaluateCompliance>) => ({
  tp: result.micro.tp,
  fp: result.micro.fp,
  fn: result.micro.fn,
  tn: result.micro.tn,
});

describe("offline compliance evaluation", () => {
  it("scores all supported supplier/type units and keeps review topics separate", () => {
    const result = evaluateCompliance(reports(), reference);
    expect(result.supplierCoverage).toEqual({ evaluated: 3, available: 3, complete: true });
    expect(result.micro).toEqual({
      tp: 3,
      fp: 0,
      fn: 0,
      tn: 6,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(result.perSupplier.map((supplier) => [supplier.supplierId, supplier.counts])).toEqual([
      ["voltline", { tp: 2, fp: 0, fn: 0, tn: 1, precision: 1, recall: 1, f1: 1 }],
      ["sparrow", { tp: 0, fp: 0, fn: 0, tn: 3, precision: null, recall: null, f1: null }],
      ["arcwell", { tp: 1, fp: 0, fn: 0, tn: 2, precision: 1, recall: 1, f1: 1 }],
    ]);
    for (const score of Object.values(result.perType)) {
      expect(score).toEqual({ tp: 1, fp: 0, fn: 0, tn: 2, precision: 1, recall: 1, f1: 1 });
    }
    expect(result.perSupplier[1]?.unscoredReferenceIssues.map((issue) => issue.type)).toEqual([
      "ambiguous_warranty",
    ]);
    expect(result.perSupplier[2]?.unscoredReferenceIssues.map((issue) => issue.type)).toEqual([
      "expired_qualification",
    ]);
    expect(result.perSupplier[1]?.reviewCandidates).toEqual([
      "warranty_terms",
      "qualification_validity",
    ]);
  });

  it("counts a missing expected finding as a false negative", () => {
    const [saved] = reports();
    saved!.assessment.findings = [{ type: "conflicting_dates" }];
    const result = evaluateCompliance([saved], reference);
    expect(result.scope).toBe("single_supplier");
    expect(result.supplierCoverage.complete).toBe(false);
    expect(result.micro).toEqual({
      tp: 1,
      fp: 0,
      fn: 1,
      tn: 1,
      precision: 1,
      recall: 0.5,
      f1: 2 / 3,
    });
    expect(result.perSupplier[0]?.expectedFindings).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
  });

  it("counts unexpected and completely wrong supported types as false positives", () => {
    const [, noExpected] = reports();
    noExpected!.assessment.findings = [{ type: "missing_evidence" }];
    const falsePositive = evaluateCompliance([noExpected], reference);
    expect(counts(falsePositive)).toEqual({ tp: 0, fp: 1, fn: 0, tn: 2 });
    expect(falsePositive.micro).toMatchObject({ precision: 0, recall: null, f1: null });

    const [wrongType] = reports();
    wrongType!.assessment.findings = [{ type: "late_completion" }];
    const incorrect = evaluateCompliance([wrongType], reference);
    expect(counts(incorrect)).toEqual({ tp: 0, fp: 1, fn: 2, tn: 0 });
    expect(incorrect.micro).toMatchObject({ precision: 0, recall: 0, f1: 0 });
  });

  it("leaves zero-denominator metrics undefined instead of inventing perfect scores", () => {
    const [, noExpected] = reports();
    const result = evaluateCompliance([noExpected], reference);
    expect(counts(result)).toEqual({ tp: 0, fp: 0, fn: 0, tn: 3 });
    expect(result.micro).toMatchObject({ precision: null, recall: null, f1: null });
    expect(result.perSupplier[0]?.assessmentStatus).toBe("requires_review");
  });

  it("deduplicates predictions for confusion counts and flags duplicates and unsupported types", () => {
    const [duplicate] = reports();
    duplicate!.assessment.findings.push({ type: "missing_evidence" });
    const duplicated = evaluateCompliance([duplicate], reference);
    expect(counts(duplicated)).toEqual({ tp: 2, fp: 0, fn: 0, tn: 1 });
    expect(duplicated.predictionValid).toBe(false);
    expect(duplicated.perSupplier[0]?.predictionIssues).toContainEqual({
      type: "missing_evidence",
      reason: "duplicate",
      count: 2,
    });

    const [, unsupported] = reports();
    unsupported!.assessment.findings = [{ type: "expired_qualification" }];
    const invalid = evaluateCompliance([unsupported], reference);
    expect(counts(invalid)).toEqual({ tp: 0, fp: 0, fn: 0, tn: 3 });
    expect(invalid.predictionValid).toBe(false);
    expect(invalid.perSupplier[0]?.actualFindings).toEqual(["expired_qualification"]);
    expect(invalid.perSupplier[0]?.predictionIssues).toContainEqual({
      type: "expired_qualification",
      reason: "unsupported_type",
      count: 1,
    });
  });

  it("keeps detection correct when saved validation is invalid or unavailable", () => {
    const [saved] = reports();
    const invalidEvidence = {
      ...saved,
      tender: { validation: { valid: true } },
      supplier: { ...saved!.supplier, validation: { valid: false } },
    };
    const result = evaluateCompliance([invalidEvidence], reference);
    expect(result.perSupplier[0]?.counts.tp).toBe(2);
    expect(result.perSupplier[0]?.savedValidation).toEqual({
      tenderValid: true,
      supplierValid: false,
      findingEvidenceIndependentlyChecked: false,
    });
    expect(evaluateCompliance([saved], reference).perSupplier[0]?.savedValidation).toMatchObject({
      tenderValid: null,
      supplierValid: null,
    });
  });

  it("rejects duplicate supplier reports and unsupported report versions", () => {
    expect(() => evaluateCompliance([voltline, voltline], reference)).toThrow(/Duplicate report/);
    expect(() => evaluateCompliance([], reference)).toThrow(/At least one/);
    expect(() => evaluateCompliance([{ ...voltline, schemaVersion: 2 }], reference)).toThrow();
  });

  it("supports saved full/RAG fixture files and stdin through the offline CLI", () => {
    const script = join(root, "scripts/evaluate-compliance.ts");
    const files = ["voltline", "sparrow", "arcwell"].map((id) =>
      join(root, `tests/fixtures/compliance-${id}.json`),
    );
    const aggregate = spawnSync(
      process.execPath,
      ["--experimental-strip-types", script, ...files],
      {
        encoding: "utf8",
      },
    );
    expect(aggregate.status, aggregate.stderr).toBe(0);
    expect(JSON.parse(aggregate.stdout).micro).toMatchObject({ tp: 3, fp: 0, fn: 0, tn: 6 });
    const stdin = spawnSync(process.execPath, ["--experimental-strip-types", script, "-"], {
      input: JSON.stringify(voltline),
      encoding: "utf8",
    });
    expect(stdin.status, stdin.stderr).toBe(0);
    expect(JSON.parse(stdin.stdout).scope).toBe("single_supplier");
  });

  it("preserves the existing extraction and retrieval evaluator outputs", async () => {
    expect(evaluateAssessment(extractionFixture, reference).combinedAccuracy).toEqual({
      passed: 0,
      total: 23,
      ratio: 0,
    });
    const tenderPdf = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    const supplierPdf = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    expect(
      evaluateRetrieval(retrievalFixture, reference, retrievalReference, tenderPdf, supplierPdf)
        .overallCoverage,
    ).toEqual({ covered: 22, total: 22, ratio: 1 });
  });
});
