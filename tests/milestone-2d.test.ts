import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import {
  BEDROCK_MODEL_ID,
  BEDROCK_REGION,
  NOVA_PRO_MODEL_ID,
} from "../packages/bedrock/src/client.ts";
import { compareCompliance2D } from "../packages/comparison/src/compare-2d.ts";
import {
  GeneralRequirementsSchema,
  ComplianceRequirementsSchema,
  extractTender2D,
  runAssessment2D,
} from "../packages/extraction/src/assessment-2d.ts";
import {
  EMPTY_TENDER,
  validateSupplier2D,
  validateTender2D,
} from "../packages/extraction/src/field-validation.ts";
import {
  SupplierExtractionSchema,
  SupplierFactsSchema,
  type SupplierFacts,
  type TenderRequirements,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (documentId: string, page: number, quote: string) => ({ documentId, page, quote });
const fact = <T>(value: T, documentId: string, page: number, quote: string) => ({
  value,
  evidence: [source(documentId, page, quote)],
});

const requirements: TenderRequirements = {
  ...EMPTY_TENDER,
  requiredPracticalCompletionDate: fact(
    "2027-05-28",
    "tender",
    1,
    "Required practical completion: no later than 28 May 2027.",
  ),
  publicLiabilityCertificateRequired: fact(
    true,
    "tender",
    2,
    "Attach current public liability and workers compensation insurance certificates.",
  ),
  workersCompensationCertificateRequired: fact(
    true,
    "tender",
    2,
    "Attach current public liability and workers compensation insurance certificates.",
  ),
};
const completeRequirements: TenderRequirements = {
  ...requirements,
  tenderId: fact("NQTC-ELEC-2026-01", "tender", 1, "Tender ID: NQTC-ELEC-2026-01."),
  closingDate: fact("2026-11-13", "tender", 1, "Tender closes: 13 November 2026 at 4:00 pm AWST."),
  siteAccessDate: fact("2027-01-11", "tender", 1, "Anticipated site access: 11 January 2027."),
  requiredCurrency: fact(
    "AUD",
    "tender",
    1,
    "Submit one ex-GST lump sum in AUD and a week-by-week programme.",
  ),
  minimumComparableReferences: fact(
    2,
    "tender",
    2,
    "Provide two comparable project references completed in the last five years.",
  ),
};
async function pdf(id: string) {
  return extractPdf(
    join(
      root,
      "datasets/electrical-installation/pdfs",
      id === "tender" ? "tender-request.pdf" : id + "-proposal.pdf",
    ),
    id,
  );
}
async function voltline(): Promise<SupplierFacts> {
  const old = JSON.parse(
    await readFile(
      join(root, "datasets/electrical-installation/baselines/2b/voltline-baseline.json"),
      "utf8",
    ),
  ) as { extracted: unknown };
  const { identifiedIssues: _issues, ...facts } = SupplierExtractionSchema.parse(old.extracted);
  void _issues;
  return SupplierFactsSchema.parse({
    ...facts,
    insuranceEvidence: {
      ...facts.insuranceEvidence,
      workersCompensation: {
        ...facts.insuranceEvidence.workersCompensation!,
        evidence: [
          source("voltline", 2, "Workers compensation certificate: attached as a declared copy."),
          source("voltline", 3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
        ],
      },
    },
  });
}
function mocked(name: string, args: Record<string, unknown>) {
  return Object.assign(
    new AIMessage({
      content: "",
      tool_calls: [{ id: "test-call", name, args, type: "tool_call" }],
    }),
    {
      response_metadata: { serviceTier: "default" },
      usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
    },
  );
}
describe("Milestone 2D field-level safety and extraction", () => {
  it("defines smaller complete schemas instead of an eight-field tender call", () => {
    expect(GeneralRequirementsSchema.keyof().options).toHaveLength(5);
    expect(ComplianceRequirementsSchema.keyof().options).toHaveLength(3);
    expect(
      GeneralRequirementsSchema.safeParse({
        tenderId: null,
        closingDate: null,
        siteAccessDate: null,
        requiredPracticalCompletionDate: null,
        requiredCurrency: null,
      }).success,
    ).toBe(true);
  });

  it("isolates an invalid insurance policy ID without losing verified status or dates", async () => {
    const [tenderDoc, supplierDoc, facts] = await Promise.all([
      pdf("tender"),
      pdf("voltline"),
      voltline(),
    ]);
    const tender = {
      extracted: requirements,
      validation: validateTender2D(requirements, tenderDoc),
    };
    const supplier = {
      extracted: facts,
      validation: validateSupplier2D(facts, supplierDoc),
    };
    expect(supplier.validation.valid).toBe(false);
    expect(supplier.validation.fields["insuranceEvidence.publicLiability.policyId"]?.status).toBe(
      "invalid",
    );
    expect(supplier.validation.fields["insuranceEvidence.publicLiability.status"]?.status).toBe(
      "valid",
    );
    expect(supplier.validation.fields.programmeCompletionDate?.status).toBe("valid");
    expect(supplier.validation.fields.commercialCompletionDate?.status).toBe("valid");
    const assessment = compareCompliance2D(tender, supplier);
    expect(assessment.findings.map((finding) => finding.type).sort()).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
    expect(assessment.status).toBe("requires_review");
  });

  it("blocks findings when their specific source facts are unsupported", async () => {
    const [tenderDoc, supplierDoc, facts] = await Promise.all([
      pdf("tender"),
      pdf("voltline"),
      voltline(),
    ]);
    const badFacts: SupplierFacts = {
      ...facts,
      programmeCompletionDate: {
        ...facts.programmeCompletionDate!,
        evidence: [source("voltline", 1, "Commercial offer completion date: 21 May 2027.")],
      },
      insuranceEvidence: {
        ...facts.insuranceEvidence,
        publicLiability: {
          ...facts.insuranceEvidence.publicLiability!,
          evidence: [
            source("voltline", 2, "Workers compensation certificate: attached as a declared copy."),
          ],
        },
      },
    };
    const result = compareCompliance2D(
      { extracted: requirements, validation: validateTender2D(requirements, tenderDoc) },
      { extracted: badFacts, validation: validateSupplier2D(badFacts, supplierDoc) },
    );
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("requires_review");
  });

  it("preserves valid general requirements when the compliance group fails", async () => {
    const [tenderDoc, supplierDoc, facts] = await Promise.all([
      pdf("tender"),
      pdf("voltline"),
      voltline(),
    ]);
    const partial = {
      ...completeRequirements,
      minimumComparableReferences: null,
      publicLiabilityCertificateRequired: null,
      workersCompensationCertificateRequired: null,
    };
    const validation = validateTender2D(partial, tenderDoc, {
      compliance: ["Incomplete tool call"],
    });
    expect(validation.fields.requiredPracticalCompletionDate?.status).toBe("valid");
    expect(validation.fields.publicLiabilityCertificateRequired?.status).toBe("invalid");
    const result = compareCompliance2D(
      { extracted: partial, validation },
      { extracted: facts, validation: validateSupplier2D(facts, supplierDoc) },
    );
    expect(result.findings.map((finding) => finding.type)).toEqual(["conflicting_dates"]);
    expect(result.reviewReasons.some((reason) => reason.includes("insurance requirement"))).toBe(
      true,
    );
  });

  it.each([
    [BEDROCK_MODEL_ID, 0.000567],
    [NOVA_PRO_MODEL_ID, 0.00756],
  ] as const)("records three isolated %s calls with model-specific cost", async (modelId, cost) => {
    const [tenderDoc, supplierDoc, facts] = await Promise.all([
      pdf("tender"),
      pdf("voltline"),
      voltline(),
    ]);
    const general = GeneralRequirementsSchema.parse(
      Object.fromEntries(
        Object.entries(completeRequirements).filter(([key]) =>
          GeneralRequirementsSchema.keyof().options.includes(key as never),
        ),
      ),
    );
    const compliance = ComplianceRequirementsSchema.parse(
      Object.fromEntries(
        Object.entries(completeRequirements).filter(([key]) =>
          ComplianceRequirementsSchema.keyof().options.includes(key as never),
        ),
      ),
    );
    const generalInvoke = vi.fn().mockResolvedValue({
      raw: mocked("extract_tender_general", general),
      parsed: general,
    });
    const complianceInvoke = vi.fn().mockResolvedValue({
      raw: mocked("extract_tender_compliance", compliance),
      parsed: compliance,
    });
    const supplierInvoke = vi.fn().mockResolvedValue({
      raw: mocked("extract_supplier_facts", facts),
      parsed: facts,
    });
    const report = await runAssessment2D(
      tenderDoc,
      supplierDoc,
      generalInvoke,
      complianceInvoke,
      supplierInvoke,
      modelId,
    );
    expect(report.version).toBe("2d");
    expect(generalInvoke).toHaveBeenCalledOnce();
    expect(complianceInvoke).toHaveBeenCalledOnce();
    expect(supplierInvoke).toHaveBeenCalledOnce();
    expect(report.tender.validation.valid).toBe(true);
    expect(report.supplier.validation.valid).toBe(false);
    expect(report.assessment.findings.map((finding) => finding.type).sort()).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
    expect(report.tender.attempts).toHaveLength(2);
    expect(report.supplier.attempts).toHaveLength(1);
    const attempts = [...report.tender.attempts, ...report.supplier.attempts];
    expect(attempts.map((attempt) => attempt.modelId)).toEqual([modelId, modelId, modelId]);
    expect(attempts.every((attempt) => attempt.region === BEDROCK_REGION)).toBe(true);
    expect(attempts.every((attempt) => attempt.tokenUsage?.input_tokens === 1000)).toBe(true);
    expect(attempts.every((attempt) => attempt.tokenUsage?.output_tokens === 500)).toBe(true);
    expect(attempts.every((attempt) => attempt.latencyMs >= 0)).toBe(true);
    expect(attempts.every((attempt) => attempt.costEstimate?.rate.modelId === modelId)).toBe(true);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(cost);
    expect(supplierInvoke.mock.calls[0]?.[0][1].text).not.toContain(
      "Required practical completion:",
    );
    expect(generalInvoke.mock.calls[0]?.[0][0].text).toContain("one complete object");
  });

  it("records the selected model on failed calls without inventing a cost", async () => {
    const failed = vi.fn().mockRejectedValue(new Error("offline invocation failure"));
    const report = await extractTender2D(await pdf("tender"), failed, failed, NOVA_PRO_MODEL_ID);
    expect(report.attempts.map((attempt) => attempt.modelId)).toEqual([
      NOVA_PRO_MODEL_ID,
      NOVA_PRO_MODEL_ID,
    ]);
    expect(report.attempts.every((attempt) => attempt.region === BEDROCK_REGION)).toBe(true);
    expect(report.attempts.every((attempt) => attempt.latencyMs >= 0)).toBe(true);
    expect(report.attempts.every((attempt) => attempt.tokenUsage === null)).toBe(true);
    expect(report.totalEstimatedCostUsd).toBeNull();
  });
});
