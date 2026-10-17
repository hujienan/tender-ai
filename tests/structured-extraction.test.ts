import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatBedrockConverse } from "@langchain/aws";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import {
  BEDROCK_MODEL_ID,
  BEDROCK_REGION,
  NOVA_PRO_MODEL_ID,
  createBedrockClient,
} from "../packages/bedrock/src/client.ts";
import { estimateBedrockCost } from "../packages/bedrock/src/pricing.ts";
import { evaluateExtraction } from "../packages/evaluation/src/evaluate.ts";
import { validateEvidence } from "../packages/extraction/src/evidence.ts";
import { extractSupplier } from "../packages/extraction/src/extract.ts";
import {
  NovaToolSchema,
  SupplierExtractionSchema,
  type SupplierExtraction,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (page: number, quote: string) => ({ documentId: "voltline", page, quote });
const fact = <T>(value: T, page: number, quote: string) => ({
  value,
  evidence: [source(page, quote)],
});

const voltline: SupplierExtraction = {
  supplierName: fact("Voltline Projects Pty Ltd", 1, "Supplier: Voltline Projects Pty Ltd"),
  priceExGst: fact(1_184_000, 1, "Ex-GST lump sum: AUD 1,184,000"),
  currency: fact("AUD", 1, "Ex-GST lump sum: AUD 1,184,000"),
  proposedDurationWeeks: fact(18, 1, "Proposed duration: 18 weeks"),
  warranty: fact(
    { months: 24, conditions: "from practical completion" },
    1,
    "Workmanship warranty: 24 months from practical completion.",
  ),
  programmeCompletionDate: fact(
    "2027-05-17",
    2,
    "Programme milestone practical completion: 17 May 2027.",
  ),
  commercialCompletionDate: fact("2027-05-21", 1, "Commercial offer completion date: 21 May 2027."),
  contractorLicence: fact("SYN-EC-101", 2, "Electrical contractor licence: SYN-EC-101"),
  supervisorQualification: fact(
    "Diploma of Electrical Engineering",
    2,
    "Supervisor qualification: Diploma of Electrical Engineering (2021).",
  ),
  comparableReferences: [
    fact("Eastbank Library upgrade", 2, "Comparable works: Eastbank Library upgrade (2024)"),
    fact("Harbor Annex fit-out", 2, "Harbor Annex fit-out (2025)"),
  ],
  insuranceEvidence: {
    publicLiability: fact(
      { status: "explicitly_missing", policyId: null },
      2,
      "Public liability cover: AUD 20 million; certificate not attached.",
    ),
    workersCompensation: {
      value: { status: "attached", policyId: "SYN-WC-101" },
      evidence: [
        source(2, "Workers compensation certificate: attached as a declared copy."),
        source(3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
      ],
    },
  },
  identifiedIssues: [
    {
      type: "missing_evidence",
      description: "Public liability certificate absent",
      evidence: [source(2, "certificate not attached.")],
    },
    {
      type: "conflicting_dates",
      description: "Commercial and programme dates differ",
      evidence: [
        source(1, "Commercial offer completion date: 21 May 2027."),
        source(2, "Programme milestone practical completion: 17 May 2027."),
      ],
    },
  ],
};

const raw = () =>
  Object.assign(new AIMessage("mock tool response"), {
    usage_metadata: { input_tokens: 1_000, output_tokens: 500, total_tokens: 1_500 },
    response_metadata: { serviceTier: "default", requestId: "mock-request" },
  });

describe("structured supplier extraction", () => {
  it("validates nullable missing information and keeps both conflicting dates", () => {
    const missing = {
      ...voltline,
      priceExGst: null,
      commercialCompletionDate: null,
      insuranceEvidence: { publicLiability: null, workersCompensation: null },
    };
    expect(SupplierExtractionSchema.safeParse(missing).success).toBe(true);
    expect(SupplierExtractionSchema.safeParse({ ...missing, currency: undefined }).success).toBe(
      false,
    );
    expect(voltline.programmeCompletionDate?.value).not.toBe(
      voltline.commercialCompletionDate?.value,
    );
  });

  it("accepts only citations on the right document and page, with whitespace tolerance", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const tender = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    expect(validateEvidence(voltline, [document]).valid).toBe(true);
    const missingInsurance = voltline.identifiedIssues[0]!;
    const withTenderCitation: SupplierExtraction = {
      ...voltline,
      identifiedIssues: [
        {
          ...missingInsurance,
          evidence: [
            ...missingInsurance.evidence,
            {
              documentId: "tender",
              page: 2,
              quote:
                "Attach current public liability and workers compensation insurance certificates.",
            },
          ],
        },
        voltline.identifiedIssues[1]!,
      ],
    };
    expect(validateEvidence(withTenderCitation, [document, tender]).valid).toBe(true);
    expect(validateEvidence(withTenderCitation, [document]).valid).toBe(false);
    const altered = {
      ...voltline,
      priceExGst: fact(1_184_000, 1, "Ex-GST  lump sum: AUD 1,184,000"),
    };
    expect(validateEvidence(altered, [document]).valid).toBe(true);
    for (const bad of [
      source(4, "Ex-GST lump sum"),
      { ...source(1, "Ex-GST"), documentId: "other" },
      source(1, "fabricated quote"),
      source(1, "  "),
    ]) {
      const result = validateEvidence({ ...voltline, priceExGst: { value: 1, evidence: [bad] } }, [
        document,
      ]);
      expect(result.valid).toBe(false);
    }
    expect(validateEvidence({ ...voltline, identifiedIssues: [] }, [document]).errors).toContain(
      "Conflicting completion dates were not identified as an issue.",
    );
  });

  it("rejects numeric values contradicted by otherwise valid quotations", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const cases: [SupplierExtraction, string][] = [
      [
        { ...voltline, priceExGst: { ...voltline.priceExGst!, value: 1_000_000 } },
        "extraction.priceExGst",
      ],
      [
        {
          ...voltline,
          proposedDurationWeeks: { ...voltline.proposedDurationWeeks!, value: 16 },
        },
        "extraction.proposedDurationWeeks",
      ],
      [
        {
          ...voltline,
          warranty: { ...voltline.warranty!, value: { ...voltline.warranty!.value, months: 12 } },
        },
        "extraction.warranty.months",
      ],
    ];
    for (const [extraction, path] of cases) {
      const result = validateEvidence(extraction, [document]);
      expect(result.errors).toEqual([
        expect.stringContaining(`${path}: no supplier quotation supports extracted numeric value`),
      ]);
    }
  });

  it("rejects supplier facts cited to a tender page even when the quote exists", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const tender = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"),
      "tender",
    );
    const result = validateEvidence(
      {
        ...voltline,
        currency: {
          value: "AUD",
          evidence: [
            {
              documentId: "tender",
              page: 1,
              quote: "Submit one ex-GST lump sum in AUD and a week-by-week programme.",
            },
          ],
        },
      },
      [document, tender],
    );
    expect(result.errors).toEqual([
      "extraction.currency.evidence[0]: supplier fact must cite supplier document voltline",
    ]);
  });

  it("flags an omitted public liability issue without changing the extraction", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const omittedIssue: SupplierExtraction = {
      ...voltline,
      identifiedIssues: [voltline.identifiedIssues[1]!],
    };
    expect(validateEvidence(omittedIssue, [document]).errors).toContain(
      "Missing public liability certificate was not identified as a missing_evidence issue.",
    );
    expect(omittedIssue.identifiedIssues).toHaveLength(1);

    const unrelatedIssue: SupplierExtraction = {
      ...omittedIssue,
      identifiedIssues: [
        {
          type: "missing_evidence",
          description: "Unrelated certificate missing",
          evidence: [source(3, "Cover: workers compensation; synthetic policy SYN-WC-101.")],
        },
        ...omittedIssue.identifiedIssues,
      ],
    };
    expect(validateEvidence(unrelatedIssue, [document]).errors).toContain(
      "Missing public liability certificate was not identified as a missing_evidence issue.",
    );
    expect(validateEvidence(voltline, [document]).valid).toBe(true);
  });

  it("rejects cover amounts as policy IDs and keeps page 3 citations exact", async () => {
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const liability = voltline.insuranceEvidence.publicLiability!;
    const coverageAsId: SupplierExtraction = {
      ...voltline,
      insuranceEvidence: {
        ...voltline.insuranceEvidence,
        publicLiability: {
          ...liability,
          value: { ...liability.value, policyId: "AUD 20 million" },
        },
      },
    };
    expect(validateEvidence(coverageAsId, [document]).errors).toContain(
      "extraction.insuranceEvidence.publicLiability.value.policyId: no supplier quotation identifies AUD 20 million as a policy number",
    );

    const pageTwoQuote = "Workers compensation certificate: attached as a declared copy.";
    const pageThreeQuote = "Cover: workers compensation; synthetic policy SYN-WC-101.";
    expect(document.pages[1]?.text).toContain(pageTwoQuote);
    expect(document.pages[2]?.text).not.toContain(pageTwoQuote);
    expect(document.pages[2]?.text).toContain(pageThreeQuote);
    const wrongPage: SupplierExtraction = {
      ...voltline,
      insuranceEvidence: {
        ...voltline.insuranceEvidence,
        workersCompensation: fact({ status: "attached", policyId: "SYN-WC-101" }, 3, pageTwoQuote),
      },
    };
    expect(validateEvidence(wrongPage, [document]).errors).toContain(
      "extraction.insuranceEvidence.workersCompensation.evidence[0]: quotation does not occur on the cited page",
    );
    expect(validateEvidence(voltline, [document]).valid).toBe(true);
  });

  it("retains raw usage, metadata and cost for valid, invalid and unparsable outputs", async () => {
    const document = {
      documentId: "voltline",
      pages: [
        { page: 1, text: "Ex-GST lump sum: AUD 1,184,000" },
        { page: 2, text: "Programme milestone practical completion: 17 May 2027." },
      ],
    };
    const invoke = vi.fn().mockResolvedValue({ raw: raw(), parsed: voltline });
    const valid = await extractSupplier(document, [], invoke);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("untrusted data");
    expect(invoke.mock.calls[0]?.[0][0].text).toContain(
      "exact contiguous text from the labelled page",
    );
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("never a cover amount");
    expect(invoke.mock.calls[0]?.[0][0].text).toContain(
      "missing_evidence issue naming public liability",
    );
    expect(invoke.mock.calls[0]?.[0][1].text).toContain("[Page 1]");
    expect(invoke.mock.calls[0]?.[0][1].text).not.toContain("reference.json");
    expect(valid.extracted?.priceExGst?.value).toBe(1_184_000);
    expect(valid.attempts[0]?.tokenUsage?.input_tokens).toBe(1_000);
    expect(valid.attempts[0]?.responseMetadata.requestId).toBe("mock-request");
    expect(valid.totalEstimatedCostUsd).toBeCloseTo(0.000189);
    expect(() => JSON.stringify(valid)).not.toThrow();
    expect(valid.validation.valid).toBe(false); // Most citations are absent from this two-line mock PDF.

    invoke.mockResolvedValueOnce({ raw: raw(), parsed: null });
    const unparsable = await extractSupplier(document, [], invoke);
    expect(unparsable.extracted).toBeNull();
    expect(unparsable.validation.valid).toBe(false);
    expect(unparsable.totalEstimatedCostUsd).toBeCloseTo(0.000189);
    expect(unparsable.attempts[0]?.rawResponse).toBeDefined();

    invoke.mockResolvedValueOnce({
      raw: raw(),
      parsed: { ...voltline, priceExGst: { value: 1, evidence: [source(1, "wrong quote")] } },
    });
    const invalidEvidence = await extractSupplier(document, [], invoke);
    expect(invalidEvidence.validation.errors.some((error) => error.includes("quotation"))).toBe(
      true,
    );
    expect(invalidEvidence.totalEstimatedCostUsd).toBeCloseTo(0.000189);

    invoke.mockResolvedValueOnce({ raw: new AIMessage("mock without usage"), parsed: null });
    const noUsage = await extractSupplier(document, [], invoke);
    expect(noUsage.attempts[0]?.rawResponse).toBeDefined();
    expect(noUsage.attempts[0]?.costError).toContain("did not return token usage");
    expect(noUsage.totalEstimatedCostUsd).toBeNull();
  });

  it("uses ChatBedrockConverse.withStructuredOutput with raw output, without AWS calls", async () => {
    const model = createBedrockClient(4096);
    model.supportsToolChoiceValues = ["tool"];
    expect(() =>
      model.withStructuredOutput(NovaToolSchema, {
        name: "extract_supplier",
        includeRaw: true,
      }),
    ).not.toThrow();

    const modelInvoke = vi.fn().mockResolvedValue({ raw: raw(), parsed: null });
    const structured = vi
      .spyOn(ChatBedrockConverse.prototype, "withStructuredOutput")
      .mockReturnValue({ invoke: modelInvoke } as never);
    try {
      await extractSupplier({ documentId: "voltline", pages: [{ page: 1, text: "synthetic" }] });
      expect(structured).toHaveBeenCalledWith(NovaToolSchema, {
        name: "extract_supplier",
        includeRaw: true,
      });
      const configured = structured.mock.contexts[0] as ChatBedrockConverse;
      expect(configured.supportsToolChoiceValues).toEqual(["tool"]);
      expect(configured.temperature).toBe(0);
      expect(Object.keys(NovaToolSchema)).toEqual(["type", "properties", "required"]);
      expect(modelInvoke).toHaveBeenCalledOnce();
    } finally {
      structured.mockRestore();
    }
  });

  it("compares saved results with reference answers only in the offline evaluator", async () => {
    const result = evaluateExtraction(
      { documentId: "voltline", extracted: voltline, validation: { valid: true } },
      reference,
    );
    expect(result.passed).toBe(result.total);
    expect(result.evidenceValid).toBe(true);
    expect(result.overallResult).toBe("acceptable");
    const qualificationWithYear = evaluateExtraction(
      {
        documentId: "voltline",
        extracted: {
          ...voltline,
          supervisorQualification: {
            ...voltline.supervisorQualification!,
            value: "Diploma of Electrical Engineering (2021)",
          },
        },
        validation: { valid: true },
      },
      reference,
    );
    expect(
      qualificationWithYear.checks.find((check) => check.field === "supervisorQualification"),
    ).toMatchObject({
      actual: "Diploma of Electrical Engineering (2021)",
      matches: true,
    });
    expect(qualificationWithYear.passed).toBe(qualificationWithYear.total);
    const differentQualification = evaluateExtraction(
      {
        documentId: "voltline",
        extracted: {
          ...voltline,
          supervisorQualification: {
            ...voltline.supervisorQualification!,
            value: "Certificate III in Electrotechnology (2021)",
          },
        },
        validation: { valid: true },
      },
      reference,
    );
    expect(
      differentQualification.checks.find((check) => check.field === "supervisorQualification")
        ?.matches,
    ).toBe(false);
    const missingPrice = evaluateExtraction(
      {
        documentId: "voltline",
        extracted: { ...voltline, priceExGst: null },
        validation: { valid: true },
      },
      reference,
    );
    expect(missingPrice.checks.find((check) => check.field === "priceExGstAud")?.matches).toBe(
      false,
    );
    expect(missingPrice.overallResult).toBe("requires_review");
    const document = await extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    );
    const correctFactsWithInvalidCitation: SupplierExtraction = {
      ...voltline,
      currency: { ...voltline.currency!, evidence: [source(1, "fabricated quote")] },
    };
    const invalidCitations = evaluateExtraction(
      {
        documentId: "voltline",
        extracted: correctFactsWithInvalidCitation,
        validation: validateEvidence(correctFactsWithInvalidCitation, [document]),
      },
      reference,
    );
    expect(invalidCitations.passed).toBe(invalidCitations.total);
    expect(invalidCitations.evidenceValid).toBe(false);
    expect(invalidCitations.overallResult).toBe("requires_review");

    const incorrectNames = evaluateExtraction(
      {
        documentId: "voltline",
        extracted: {
          ...voltline,
          comparableReferences: voltline.comparableReferences.map((entry, index) => ({
            ...entry,
            value: `Incorrect project ${index + 1}`,
          })),
        },
        validation: { valid: true },
      },
      reference,
    );
    expect(
      incorrectNames.checks.find((check) => check.field === "comparableReferencesCount"),
    ).toMatchObject({
      expected: 2,
      actual: 2,
      matches: true,
    });
    expect(incorrectNames.checks.some((check) => check.field === "comparableReferences")).toBe(
      false,
    );
  });
});

describe("Bedrock cost estimates", () => {
  it("uses the Sydney direct-model rate and actual token counts", () => {
    expect(
      estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "default", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }).estimatedUsd,
    ).toBeCloseTo(0.315);
    const pro = estimateBedrockCost(NOVA_PRO_MODEL_ID, BEDROCK_REGION, "default", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(pro.estimatedUsd).toBeCloseTo(4.2);
    expect(pro.rate).toMatchObject({
      modelId: NOVA_PRO_MODEL_ID,
      inputUsdPerMillion: 0.84,
      outputUsdPerMillion: 3.36,
    });
  });

  it("refuses profile, region, tier, cached-token and invalid-usage mispricing", () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    expect(() =>
      estimateBedrockCost("apac.amazon.nova-lite-v1:0", BEDROCK_REGION, "default", usage),
    ).toThrow("No configured price");
    expect(() =>
      estimateBedrockCost("apac.amazon.nova-pro-v1:0", BEDROCK_REGION, "default", usage),
    ).toThrow("No configured price");
    expect(() => estimateBedrockCost(BEDROCK_MODEL_ID, "us-east-1", "default", usage)).toThrow(
      "No configured price",
    );
    expect(() => estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "priority", usage)).toThrow(
      "No configured price",
    );
    expect(() =>
      estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "default", {
        ...usage,
        input_token_details: { cache_read: 1 },
      }),
    ).toThrow("Cached tokens");
    expect(() =>
      estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "default", {
        ...usage,
        input_token_details: { cache_read: -1 },
      }),
    ).toThrow("Valid cached token counts");
    expect(() =>
      estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "default", {
        ...usage,
        output_tokens: -1,
      }),
    ).toThrow("Valid input");
  });
});
