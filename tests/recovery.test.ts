import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { BEDROCK_REGION, NOVA_PRO_MODEL_ID } from "../packages/bedrock/src/client.ts";
import { runTenderAssessment } from "../packages/assessment/src/run.ts";
import { SupplierFactsSchema } from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import { voltlineWithUnsupportedPolicyId } from "./fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = (documentId: string, page: number, quote: string) => [{ documentId, page, quote }];
const fact = <T>(value: T, documentId: string, page: number, quote: string) => ({
  value,
  evidence: evidence(documentId, page, quote),
});
const general = {
  tenderId: fact("NQTC-ELEC-2026-01", "tender", 1, "Tender ID: NQTC-ELEC-2026-01."),
  closingDate: fact("2026-11-13", "tender", 1, "Tender closes: 13 November 2026 at 4:00 pm AWST."),
  siteAccessDate: fact("2027-01-11", "tender", 1, "Anticipated site access: 11 January 2027."),
  requiredPracticalCompletionDate: fact(
    "2027-05-28",
    "tender",
    1,
    "Required practical completion: no later than 28 May 2027.",
  ),
  requiredCurrency: fact(
    "AUD",
    "tender",
    1,
    "Submit one ex-GST lump sum in AUD and a week-by-week programme.",
  ),
};
const compliance = {
  minimumComparableReferences: fact(
    2,
    "tender",
    2,
    "Provide two comparable project references completed in the last five years.",
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

async function documents() {
  const dir = join(root, "datasets/electrical-installation/pdfs");
  return Promise.all([
    extractPdf(join(dir, "tender-request.pdf"), "tender"),
    extractPdf(join(dir, "voltline-proposal.pdf"), "voltline"),
  ]);
}

async function supplierFacts() {
  return SupplierFactsSchema.parse(voltlineWithUnsupportedPolicyId());
}

function response(name: string, args: Record<string, unknown>[], usage = true) {
  const raw = new AIMessage({
    content: "",
    tool_calls: args.map((entry, index) => ({
      id: `call-${index + 1}`,
      name,
      args: entry,
      type: "tool_call" as const,
    })),
  });
  raw.response_metadata = { serviceTier: "default", requestId: "mock-request" };
  if (usage)
    Object.assign(raw, {
      usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
    });
  return { raw, parsed: args[0] };
}

function successInvokes(supplier: Awaited<ReturnType<typeof supplierFacts>>) {
  return {
    generalInvoke: vi.fn().mockResolvedValue(response("extract_tender_general", [general])),
    complianceInvoke: vi
      .fn()
      .mockResolvedValue(response("extract_tender_compliance", [compliance])),
    supplierInvoke: vi.fn().mockResolvedValue(response("extract_supplier_facts", [supplier])),
  };
}

describe("bounded extraction recovery", () => {
  it("does not retry complete responses, including evidence errors", async () => {
    const [tender, supplierDoc] = await documents();
    const supplier = await supplierFacts();
    const calls = successInvokes(supplier);
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(calls.generalInvoke).toHaveBeenCalledOnce();
    expect(calls.complianceInvoke).toHaveBeenCalledOnce();
    expect(calls.supplierInvoke).toHaveBeenCalledOnce();
    expect(report.tender.extracted.tenderId).toEqual(general.tenderId);
    expect(report.tender.groups.general.recovery?.retried).toBe(false);
    expect(report.supplier.recovery?.retried).toBe(false);
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.policyId"]?.status,
    ).toBe("invalid");
  });

  it("retries only a ToolUse failure with the same selected model", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    calls.complianceInvoke.mockRejectedValueOnce(
      new Error("Model produced invalid sequence as part of ToolUse."),
    );
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
      NOVA_PRO_MODEL_ID,
    );
    expect(calls.generalInvoke).toHaveBeenCalledOnce();
    expect(calls.complianceInvoke).toHaveBeenCalledTimes(2);
    expect(calls.supplierInvoke).toHaveBeenCalledOnce();
    expect(report.tender.validation.fields.publicLiabilityCertificateRequired?.status).toBe(
      "valid",
    );
    expect(report.tender.groups.compliance.recovery?.retried).toBe(true);
    expect(
      report.tender.groups.compliance.recovery?.recoveredFields.publicLiabilityCertificateRequired
        ?.attempt,
    ).toBe(2);
    expect(report.tender.groups.compliance.attempts[0]?.error).toContain("ToolUse");
    expect(report.tender.groups.compliance.attempts.map((attempt) => attempt.modelId)).toEqual([
      NOVA_PRO_MODEL_ID,
      NOVA_PRO_MODEL_ID,
    ]);
    expect(
      report.tender.groups.compliance.attempts.every(
        (attempt) => attempt.region === BEDROCK_REGION,
      ),
    ).toBe(true);
    expect(report.totalEstimatedCostUsd).toBeNull();
    expect(report.knownEstimatedCostUsd).toBeCloseTo(0.00756);
  });

  it("stops after two failures and leaves the assessment requiring review", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    calls.generalInvoke.mockRejectedValue(new Error("ToolUse failed"));
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(calls.generalInvoke).toHaveBeenCalledTimes(2);
    expect(calls.complianceInvoke).toHaveBeenCalledOnce();
    expect(calls.supplierInvoke).toHaveBeenCalledOnce();
    expect(report.tender.groups.general.attempts).toHaveLength(2);
    expect(
      report.tender.groups.general.attempts.every((attempt) => attempt.error?.includes("ToolUse")),
    ).toBe(true);
    expect(report.tender.validation.fields.requiredPracticalCompletionDate?.status).toBe("invalid");
    expect(report.assessment.status).toBe("requires_review");
    expect(report.totalEstimatedCostUsd).toBeNull();
    expect(report.knownEstimatedCostUsd).toBeGreaterThan(0);
  });

  it("recovers only cited and schema-valid fields from incomplete tender output", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    const badDate = { ...general.closingDate, evidence: general.tenderId.evidence };
    calls.generalInvoke
      .mockResolvedValueOnce(
        response("extract_tender_general", [
          {
            tenderId: general.tenderId,
            closingDate: badDate,
            siteAccessDate: fact(
              "11 January 2027",
              "tender",
              1,
              "Anticipated site access: 11 January 2027.",
            ),
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("ToolUse failed"));
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(report.tender.extracted.tenderId).toEqual(general.tenderId);
    expect(report.tender.extracted.closingDate).toBeNull();
    expect(report.tender.validation.fields.tenderId?.status).toBe("valid");
    expect(report.tender.validation.fields.closingDate?.status).toBe("invalid");
    expect(report.tender.validation.fields.siteAccessDate?.status).toBe("invalid");
    expect(report.tender.groups.general.recovery?.recoveredFields.tenderId?.evidence).toEqual(
      general.tenderId.evidence,
    );
    expect(report.tender.groups.general.recovery?.unresolvedFields).toContain("closingDate");
  });

  it("audits multiple partial tool calls and rejects conflicting values", async () => {
    const [tender, supplierDoc] = await documents();
    const conflictingTender = {
      ...tender,
      pages: tender.pages.map((page) =>
        page.page === 1 ? { ...page, text: page.text + " Tender ID: OTHER." } : page,
      ),
    };
    const calls = successInvokes(await supplierFacts());
    calls.generalInvoke
      .mockResolvedValueOnce(
        response("extract_tender_general", [
          { tenderId: general.tenderId },
          { requiredCurrency: general.requiredCurrency },
        ]),
      )
      .mockResolvedValueOnce(
        response("extract_tender_general", [
          { tenderId: fact("OTHER", "tender", 1, "Tender ID: OTHER.") },
          { siteAccessDate: general.siteAccessDate },
        ]),
      );
    const report = await runTenderAssessment(
      conflictingTender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    const recovery = report.tender.groups.general.recovery!;
    expect(report.tender.extracted.tenderId).toBeNull();
    expect(report.tender.validation.fields.tenderId?.status).toBe("invalid");
    expect(report.tender.validation.fields.requiredCurrency?.status).toBe("valid");
    expect(recovery.recoveredFields.requiredCurrency).toMatchObject({
      attempt: 1,
      toolCallId: "call-2",
    });
    expect(recovery.recoveredFields.siteAccessDate).toMatchObject({
      attempt: 2,
      toolCallId: "call-2",
    });
    expect(report.tender.groups.general.attempts[0]?.rawResponse?.tool_calls).toHaveLength(2);
    expect(recovery.fieldErrors.tenderId?.[0]).toContain("conflicting values");
  });

  it("ignores an unsupported tender ID when the retry cites the correct ID", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    calls.generalInvoke
      .mockResolvedValueOnce(
        response("extract_tender_general", [
          { tenderId: fact("OTHER", "tender", 1, "Tender ID: NQTC-ELEC-2026-01.") },
        ]),
      )
      .mockResolvedValueOnce(response("extract_tender_general", [general]));
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    const recovery = report.tender.groups.general.recovery!;
    expect(calls.generalInvoke).toHaveBeenCalledTimes(2);
    expect(report.tender.extracted.tenderId).toEqual(general.tenderId);
    expect(report.tender.validation.fields.tenderId?.status).toBe("valid");
    expect(recovery.fieldErrors.tenderId).toBeUndefined();
    expect(recovery.recoveredFields.tenderId).toEqual({
      attempt: 2,
      toolCallId: "call-1",
      evidence: general.tenderId.evidence,
    });
    expect(report.tender.groups.general.attempts[0]?.rawResponse?.tool_calls?.[0]?.args).toEqual({
      tenderId: fact("OTHER", "tender", 1, "Tender ID: NQTC-ELEC-2026-01."),
    });
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000756);
  });

  it("ignores an unsupported insurance status while keeping an unsupported policy ID invalid", async () => {
    const [tender, supplierDoc] = await documents();
    const supplier = await supplierFacts();
    const calls = successInvokes(supplier);
    const unsupported = {
      value: { status: "attached", policyId: null },
      evidence: evidence(
        "voltline",
        2,
        "Workers compensation certificate: attached as a declared copy.",
      ),
    };
    calls.supplierInvoke
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [
          { insuranceEvidence: { publicLiability: unsupported } },
        ]),
      )
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [
          { insuranceEvidence: { publicLiability: supplier.insuranceEvidence.publicLiability } },
        ]),
      );
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    const recovery = report.supplier.recovery!;
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.status"]?.status,
    ).toBe("valid");
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.policyId"]?.status,
    ).toBe("invalid");
    expect(recovery.fieldErrors["insuranceEvidence.publicLiability.status"]).toBeUndefined();
    expect(recovery.recoveredFields["insuranceEvidence.publicLiability"]).toEqual({
      attempt: 2,
      toolCallId: "call-1",
      evidence: supplier.insuranceEvidence.publicLiability?.evidence,
    });
    expect(report.assessment.findings.map((finding) => finding.type)).toContain("missing_evidence");
    expect(report.supplier.attempts[0]?.rawResponse?.tool_calls?.[0]?.args).toEqual({
      insuranceEvidence: { publicLiability: unsupported },
    });
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000756);
  });

  it("keeps independently supported insurance statuses in conflict under review", async () => {
    const [tender, supplierDoc] = await documents();
    const conflictingSupplier = {
      ...supplierDoc,
      pages: supplierDoc.pages.map((page) =>
        page.page === 2
          ? { ...page, text: page.text + " Public liability certificate: attached." }
          : page,
      ),
    };
    const supplier = await supplierFacts();
    const calls = successInvokes(supplier);
    const missing = {
      ...supplier.insuranceEvidence.publicLiability!,
      value: { status: "explicitly_missing", policyId: null },
    };
    const attached = {
      value: { status: "attached", policyId: null },
      evidence: evidence("voltline", 2, "Public liability certificate: attached."),
    };
    calls.supplierInvoke
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [{ insuranceEvidence: { publicLiability: missing } }]),
      )
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [{ insuranceEvidence: { publicLiability: attached } }]),
      );
    const report = await runTenderAssessment(
      tender,
      conflictingSupplier,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.status"]?.status,
    ).toBe("invalid");
    expect(
      report.supplier.recovery?.fieldErrors["insuranceEvidence.publicLiability.status"]?.[0],
    ).toContain("conflicting values");
    expect(report.assessment.findings.map((finding) => finding.type)).not.toContain(
      "missing_evidence",
    );
    expect(report.assessment.status).toBe("requires_review");
  });

  it("ignores an unsupported policy ID when the retry supplies a cited ID", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    const attachedQuote = "Workers compensation certificate: attached as a declared copy.";
    const first = {
      value: { status: "attached", policyId: "AUD 20 million" },
      evidence: evidence("voltline", 2, attachedQuote),
    };
    const second = {
      value: { status: "attached", policyId: "SYN-WC-101" },
      evidence: [
        ...evidence("voltline", 2, attachedQuote),
        ...evidence("voltline", 3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
      ],
    };
    calls.supplierInvoke
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [{ insuranceEvidence: { workersCompensation: first } }]),
      )
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [
          { insuranceEvidence: { workersCompensation: second } },
        ]),
      );
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(
      report.supplier.validation.fields["insuranceEvidence.workersCompensation.status"]?.status,
    ).toBe("valid");
    expect(
      report.supplier.validation.fields["insuranceEvidence.workersCompensation.policyId"]?.status,
    ).toBe("valid");
    expect(
      report.supplier.recovery?.recoveredFields["insuranceEvidence.workersCompensation"]?.attempt,
    ).toBe(2);
    expect(
      report.supplier.recovery?.fieldErrors["insuranceEvidence.workersCompensation.policyId"],
    ).toBeUndefined();
  });

  it("keeps independently supported policy IDs in conflict while preserving certificate status", async () => {
    const [tender, supplierDoc] = await documents();
    const conflictingSupplier = {
      ...supplierDoc,
      pages: supplierDoc.pages.map((page) =>
        page.page === 3
          ? {
              ...page,
              text:
                page.text +
                " Workers compensation certificate: attached; policy number SYN-WC-202.",
            }
          : page,
      ),
    };
    const calls = successInvokes(await supplierFacts());
    const first = {
      value: { status: "attached", policyId: "SYN-WC-101" },
      evidence: [
        ...evidence(
          "voltline",
          2,
          "Workers compensation certificate: attached as a declared copy.",
        ),
        ...evidence("voltline", 3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
      ],
    };
    const second = {
      value: { status: "attached", policyId: "SYN-WC-202" },
      evidence: evidence(
        "voltline",
        3,
        "Workers compensation certificate: attached; policy number SYN-WC-202.",
      ),
    };
    calls.supplierInvoke
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [{ insuranceEvidence: { workersCompensation: first } }]),
      )
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [
          { insuranceEvidence: { workersCompensation: second } },
        ]),
      );
    const report = await runTenderAssessment(
      tender,
      conflictingSupplier,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(
      report.supplier.validation.fields["insuranceEvidence.workersCompensation.status"]?.status,
    ).toBe("valid");
    expect(
      report.supplier.validation.fields["insuranceEvidence.workersCompensation.policyId"]?.status,
    ).toBe("invalid");
    expect(
      report.supplier.recovery?.fieldErrors["insuranceEvidence.workersCompensation.policyId"]?.[0],
    ).toContain("conflicting values");
    expect(report.assessment.status).toBe("requires_review");
  });

  it("recovers an insurance status independently of an unsupported policy ID", async () => {
    const [tender, supplierDoc] = await documents();
    const supplier = await supplierFacts();
    const calls = successInvokes(supplier);
    calls.supplierInvoke
      .mockResolvedValueOnce(
        response("extract_supplier_facts", [
          {
            proposedDurationWeeks: supplier.proposedDurationWeeks,
            insuranceEvidence: { publicLiability: supplier.insuranceEvidence.publicLiability },
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("ToolUse failed"));
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(calls.supplierInvoke).toHaveBeenCalledTimes(2);
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.status"]?.status,
    ).toBe("valid");
    expect(report.supplier.validation.fields.proposedDurationWeeks?.status).toBe("valid");
    expect(
      report.supplier.validation.fields["insuranceEvidence.publicLiability.policyId"]?.status,
    ).toBe("invalid");
    expect(report.assessment.findings.map((finding) => finding.type)).toContain("missing_evidence");
    expect(
      report.supplier.recovery?.recoveredFields["insuranceEvidence.publicLiability"]?.attempt,
    ).toBe(1);
    expect(report.supplier.attempts).toHaveLength(2);
    expect(report.totalEstimatedCostUsd).toBeNull();
    expect(report.knownEstimatedCostUsd).toBeCloseTo(0.000567);
  });

  it("sums priced retries and keeps missing usage outside the complete total", async () => {
    const [tender, supplierDoc] = await documents();
    const calls = successInvokes(await supplierFacts());
    calls.generalInvoke
      .mockResolvedValueOnce(response("extract_tender_general", [{ tenderId: general.tenderId }]))
      .mockResolvedValueOnce(response("extract_tender_general", [general]));
    const report = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(report.tender.groups.general.attempts).toHaveLength(2);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000756);
    expect(report.knownEstimatedCostUsd).toBeCloseTo(0.000756);
    expect(report.tender.groups.general.attempts[0]?.responseMetadata.requestId).toBe(
      "mock-request",
    );
    expect(report.tender.groups.general.attempts[0]?.latencyMs).toBeGreaterThanOrEqual(0);

    calls.generalInvoke
      .mockReset()
      .mockResolvedValueOnce(
        response("extract_tender_general", [{ tenderId: general.tenderId }], false),
      )
      .mockResolvedValueOnce(response("extract_tender_general", [general]));
    const missingUsage = await runTenderAssessment(
      tender,
      supplierDoc,
      calls.generalInvoke,
      calls.complianceInvoke,
      calls.supplierInvoke,
    );
    expect(missingUsage.totalEstimatedCostUsd).toBeNull();
    expect(missingUsage.knownEstimatedCostUsd).toBeCloseTo(0.000567);
    expect(missingUsage.tender.groups.general.attempts[0]?.costError).toContain("token usage");
  });
});
