import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { compareCompliance } from "../packages/comparison/src/compare.ts";
import { runAssessment } from "../packages/comparison/src/workflow.ts";
import { evaluateAssessment, evaluateExtraction } from "../packages/evaluation/src/evaluate.ts";
import {
  validateSupplierFacts,
  validateTenderRequirements,
} from "../packages/extraction/src/evidence.ts";
import {
  extractSupplierFacts,
  extractTenderRequirements,
} from "../packages/extraction/src/facts.ts";
import {
  SupplierExtractionSchema,
  SupplierFactsSchema,
  SupplierFactsToolSchema,
  TenderRequirementsSchema,
  TenderRequirementsToolSchema,
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
const insuranceRequirement =
  "Attach current public liability and workers compensation insurance certificates.";

const tenderFacts: TenderRequirements = {
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
  minimumComparableReferences: fact(
    2,
    "tender",
    2,
    "Provide two comparable project references completed in the last five years.",
  ),
  publicLiabilityCertificateRequired: fact(true, "tender", 2, insuranceRequirement),
  workersCompensationCertificateRequired: fact(true, "tender", 2, insuranceRequirement),
};

async function archived(name: string) {
  return JSON.parse(
    await readFile(
      join(root, "datasets/electrical-installation/baselines/2b", `${name}.json`),
      "utf8",
    ),
  ) as {
    documentId: string;
    extracted: unknown;
    validation: { valid: boolean };
  };
}

async function pdf(id: "tender" | "voltline" | "sparrow" | "arcwell") {
  const file = id === "tender" ? "tender-request.pdf" : `${id}-proposal.pdf`;
  return extractPdf(join(root, "datasets/electrical-installation/pdfs", file), id);
}

function raw(name: string, ...args: Record<string, unknown>[]) {
  return Object.assign(
    new AIMessage({
      content: "",
      tool_calls: args.map((value, index) => ({
        id: `mock-tool-${index}`,
        name,
        args: value,
        type: "tool_call" as const,
      })),
    }),
    {
      usage_metadata: { input_tokens: 1_000, output_tokens: 500, total_tokens: 1_500 },
      response_metadata: { serviceTier: "default", requestId: "mock-request" },
    },
  );
}

async function correctedVoltlineFacts(): Promise<SupplierFacts> {
  const baseline = SupplierExtractionSchema.parse((await archived("voltline-baseline")).extracted);
  const { identifiedIssues: _issues, ...facts } = baseline;
  void _issues;
  const liability = facts.insuranceEvidence.publicLiability!;
  const workers = facts.insuranceEvidence.workersCompensation!;
  return SupplierFactsSchema.parse({
    ...facts,
    insuranceEvidence: {
      publicLiability: { ...liability, value: { ...liability.value, policyId: null } },
      workersCompensation: {
        ...workers,
        evidence: [
          source("voltline", 2, "Workers compensation certificate: attached as a declared copy."),
          source("voltline", 3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
        ],
      },
    },
  });
}

describe("Milestone 2C source boundaries and comparison", () => {
  it("sends a complete schema with required fields and ISO date constraints", () => {
    expect(TenderRequirementsToolSchema.required).toEqual(Object.keys(tenderFacts));
    expect(Object.keys(TenderRequirementsToolSchema.properties ?? {})).toEqual(
      Object.keys(tenderFacts),
    );
    expect(SupplierFactsToolSchema.required).toEqual(
      Object.keys(SupplierFactsToolSchema.properties ?? {}),
    );
    expect(JSON.stringify(TenderRequirementsToolSchema)).toContain('"format":"date"');
    expect(JSON.stringify(TenderRequirementsToolSchema)).not.toContain('"$ref"');
  });

  it("rejects multiple partial tender calls and reports their missing fields with cost retained", async () => {
    const tender = await pdf("tender");
    const partials = Object.entries(tenderFacts).map(([field, value]) => ({ [field]: value }));
    const response = raw("extract_tender_requirements", ...partials);
    const invoke = vi.fn().mockResolvedValue({ raw: response, parsed: partials[0] });
    const report = await extractTenderRequirements(tender, invoke);

    expect(report.extracted).toBeNull();
    expect(report.validation.errors[0]).toContain("received 8");
    expect(report.validation.errors).toContain(
      "Incomplete extract_tender_requirements object: missing closingDate, siteAccessDate, requiredPracticalCompletionDate, requiredCurrency, minimumComparableReferences, publicLiabilityCertificateRequired, workersCompensationCertificateRequired.",
    );
    expect(report.attempts[0]?.rawResponse).toBe(response);
    expect(report.attempts[0]?.tokenUsage?.input_tokens).toBe(1_000);
    expect(report.attempts[0]?.tokenUsage?.output_tokens).toBe(500);
    expect(report.attempts[0]?.responseMetadata.requestId).toBe("mock-request");
    expect(report.attempts[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000189);
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("exactly once with one complete object");
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("ISO YYYY-MM-DD");
  });

  it("rejects a single incomplete tender call and non-ISO dates", async () => {
    const tender = await pdf("tender");
    const partial = { tenderId: tenderFacts.tenderId };
    const incomplete = await extractTenderRequirements(
      tender,
      vi.fn().mockResolvedValue({
        raw: raw("extract_tender_requirements", partial),
        parsed: partial,
      }),
    );
    expect(incomplete.extracted).toBeNull();
    expect(incomplete.validation.errors.some((error) => error.startsWith("Incomplete"))).toBe(true);

    const nonIso = {
      ...tenderFacts,
      closingDate: { ...tenderFacts.closingDate!, value: "13 November 2026 at 4:00 pm AWST" },
    };
    const dated = await extractTenderRequirements(
      tender,
      vi.fn().mockResolvedValue({
        raw: raw("extract_tender_requirements", nonIso),
        parsed: nonIso,
      }),
    );
    expect(dated.extracted).toBeNull();
    expect(dated.validation.errors.some((error) => error.startsWith("closingDate.value:"))).toBe(
      true,
    );
  });

  it("rejects the observed supplier citation and policy ID failures without changing the facts", async () => {
    const supplier = await pdf("voltline");
    const facts = await correctedVoltlineFacts();
    const flawed = {
      ...facts,
      proposedDurationWeeks: {
        ...facts.proposedDurationWeeks!,
        evidence: [source("voltline", 2, "Programme milestone practical completion: 17 May 2027.")],
      },
      comparableReferences: [
        facts.comparableReferences[0]!,
        {
          ...facts.comparableReferences[1]!,
          evidence: [source("voltline", 2, "Comparable works: Harbor Annex fit-out (2025)")],
        },
      ],
      insuranceEvidence: {
        ...facts.insuranceEvidence,
        publicLiability: {
          ...facts.insuranceEvidence.publicLiability!,
          value: { status: "explicitly_missing" as const, policyId: "AUD 20 million" },
        },
      },
    };
    const invoke = vi.fn().mockResolvedValue({
      raw: raw("extract_supplier_facts", flawed),
      parsed: flawed,
    });
    const report = await extractSupplierFacts(supplier, invoke);
    expect(report.extracted).toEqual(flawed);
    expect(report.validation.errors).toContain(
      "extraction.proposedDurationWeeks: no supplier quotation supports extracted numeric value 18",
    );
    expect(report.validation.errors).toContain(
      "extraction.comparableReferences[1].evidence[0]: quotation does not occur on the cited page",
    );
    expect(report.validation.errors).toContain(
      "extraction.insuranceEvidence.publicLiability.value.policyId: no supplier quotation identifies AUD 20 million as a policy number",
    );
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000189);
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("directly supports that field's value");
    expect(invoke.mock.calls[0]?.[0][0].text).toContain(
      "Duration must cite the duration statement",
    );
  });

  it("associates certificate statements and cover claims with the named insurance type", async () => {
    const supplier = await pdf("voltline");
    const facts = await correctedVoltlineFacts();
    const page = supplier.pages.length + 1;
    const validate = (
      kind: "publicLiability" | "workersCompensation",
      status: "attached" | "claimed_only",
      quote: string,
    ) =>
      validateSupplierFacts(
        {
          ...facts,
          insuranceEvidence: {
            ...facts.insuranceEvidence,
            [kind]: {
              value: { status, policyId: null },
              evidence: [source("voltline", page, quote)],
            },
          },
        },
        { ...supplier, pages: [...supplier.pages, { page, text: quote }] },
      );

    for (const [kind, other, quote] of [
      [
        "publicLiability",
        "workersCompensation",
        "Public liability cover: AUD 20 million; Workers compensation certificate: attached.",
      ],
      [
        "workersCompensation",
        "publicLiability",
        "Workers compensation cover: AUD 20 million; Public liability certificate: attached.",
      ],
    ] as const) {
      expect(validate(kind, "attached", quote).errors).toContain(
        `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support attached`,
      );
      expect(validate(kind, "claimed_only", quote).valid).toBe(true);
      expect(validate(other, "attached", quote).valid).toBe(true);
    }
    for (const [kind, quote] of [
      ["publicLiability", "No public liability cover is maintained."],
      ["workersCompensation", "No workers compensation cover is maintained."],
      ["publicLiability", "Public liability cover is not maintained."],
      ["workersCompensation", "Workers compensation cover is not maintained."],
    ] as const) {
      expect(validate(kind, "claimed_only", quote).errors).toContain(
        `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support claimed_only`,
      );
    }
  });

  it("rejects insurance statuses contradicted or unsupported by supplier quotations", async () => {
    const supplier = await pdf("voltline");
    const facts = await correctedVoltlineFacts();
    const liability = facts.insuranceEvidence.publicLiability!;
    const workers = facts.insuranceEvidence.workersCompensation!;
    const liabilityWith = (
      status: "attached" | "explicitly_missing" | "claimed_only",
      quote: string,
    ) => ({
      ...facts,
      insuranceEvidence: {
        ...facts.insuranceEvidence,
        publicLiability: {
          ...liability,
          value: { status, policyId: null },
          evidence: [source("voltline", 2, quote)],
        },
      },
    });
    const absent = "Public liability cover: AUD 20 million; certificate not attached.";
    const statusError = (kind: string, status: string) =>
      `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support ${status}`;

    expect(validateSupplierFacts(liabilityWith("explicitly_missing", absent), supplier).valid).toBe(
      true,
    );
    const contradictory = liabilityWith("attached", absent);
    const validation = validateSupplierFacts(contradictory, supplier);
    expect(validation.errors).toContain(statusError("publicLiability", "attached"));
    expect(contradictory.insuranceEvidence.publicLiability?.value.status).toBe("attached");
    expect(
      compareCompliance(
        { extracted: tenderFacts, validation: { valid: true, errors: [] } },
        { extracted: contradictory, validation },
      ).status,
    ).toBe("requires_review");
    expect(validateSupplierFacts(liabilityWith("claimed_only", absent), supplier).errors).toContain(
      statusError("publicLiability", "claimed_only"),
    );
    expect(
      validateSupplierFacts(
        liabilityWith("attached", "Public liability cover: AUD 20 million"),
        supplier,
      ).errors,
    ).toContain(statusError("publicLiability", "attached"));
    expect(
      validateSupplierFacts(
        {
          ...facts,
          insuranceEvidence: {
            ...facts.insuranceEvidence,
            workersCompensation: {
              ...workers,
              value: { ...workers.value, status: "explicitly_missing" },
            },
          },
        },
        supplier,
      ).errors,
    ).toContain(statusError("workersCompensation", "explicitly_missing"));
    expect(
      validateSupplierFacts(
        {
          ...facts,
          insuranceEvidence: {
            ...facts.insuranceEvidence,
            workersCompensation: {
              ...workers,
              value: { ...workers.value, status: "claimed_only" },
            },
          },
        },
        supplier,
      ).errors,
    ).toContain(statusError("workersCompensation", "claimed_only"));
  });

  it("keeps tender requirements and supplier facts separate, with exact source evidence", async () => {
    const tender = await pdf("tender");
    const supplier = await pdf("voltline");
    const facts = await correctedVoltlineFacts();
    expect(TenderRequirementsSchema.safeParse(tenderFacts).success).toBe(true);
    expect(SupplierFactsSchema.safeParse({ ...facts, identifiedIssues: [] }).success).toBe(false);
    expect(validateTenderRequirements(tenderFacts, tender).valid).toBe(true);
    expect(validateSupplierFacts(facts, supplier).valid).toBe(true);
    expect(
      validateTenderRequirements(
        {
          ...tenderFacts,
          requiredPracticalCompletionDate: fact(
            "2027-05-28",
            "voltline",
            1,
            "Required practical completion: no later than 28 May 2027.",
          ),
        },
        tender,
      ).valid,
    ).toBe(false);
    expect(
      validateTenderRequirements(
        {
          ...tenderFacts,
          requiredPracticalCompletionDate: fact(
            "2027-05-28",
            "tender",
            2,
            "Required practical completion: no later than 28 May 2027.",
          ),
        },
        tender,
      ).valid,
    ).toBe(false);
    expect(
      validateTenderRequirements(
        {
          ...tenderFacts,
          requiredPracticalCompletionDate: {
            ...tenderFacts.requiredPracticalCompletionDate!,
            value: "2027-05-27",
          },
        },
        tender,
      ).errors,
    ).toContain(
      "requirements.requiredPracticalCompletionDate: cited quotation does not support the extracted date",
    );
    expect(
      validateSupplierFacts(
        {
          ...facts,
          programmeCompletionDate: { ...facts.programmeCompletionDate!, value: "2027-05-28" },
        },
        supplier,
      ).errors,
    ).toContain(
      "extraction.programmeCompletionDate: cited quotation does not support the extracted date",
    );
  });

  it("keeps archived 2B scores and exposes observed source and null failures", async () => {
    for (const [name, expected] of [
      ["voltline-baseline", 11],
      ["sparrow", 9],
      ["arcwell", 10],
    ] as const) {
      const saved = await archived(name);
      const extracted = SupplierExtractionSchema.parse(saved.extracted);
      expect(evaluateExtraction({ ...saved, extracted }, reference).passed).toBe(expected);
      const { identifiedIssues: _issues, ...facts } = extracted;
      void _issues;
      if (name === "arcwell") {
        expect(SupplierFactsSchema.safeParse(facts).success).toBe(false);
        expect(
          SupplierFactsSchema.safeParse({
            ...facts,
            warranty: {
              ...facts.warranty!,
              value: { ...facts.warranty!.value, conditions: null },
            },
          }).success,
        ).toBe(true);
      }
      if (name === "sparrow" || name === "arcwell") {
        const parsed = SupplierFactsSchema.parse(
          name === "arcwell"
            ? {
                ...facts,
                warranty: {
                  ...facts.warranty!,
                  value: { ...facts.warranty!.value, conditions: null },
                },
              }
            : facts,
        );
        expect(validateSupplierFacts(parsed, await pdf(name)).errors).toContain(
          "extraction.commercialCompletionDate.evidence[0]: unknown document ID tender",
        );
      }
    }
    const baseline = SupplierExtractionSchema.parse(
      (await archived("voltline-baseline")).extracted,
    );
    const { identifiedIssues: _issues, ...voltlineFacts } = baseline;
    void _issues;
    expect(
      validateSupplierFacts(SupplierFactsSchema.parse(voltlineFacts), await pdf("voltline")).errors,
    ).toContain(
      "extraction.insuranceEvidence.publicLiability.value.policyId: no supplier quotation identifies AUD 20 million as a policy number",
    );
  });

  it("emits only supported deterministic findings and marks uncertain inputs for review", async () => {
    const facts = await correctedVoltlineFacts();
    const tender = { extracted: tenderFacts, validation: { valid: true, errors: [] } };
    const voltline = { extracted: facts, validation: { valid: true, errors: [] } };
    const result = compareCompliance(tender, voltline);
    expect(result.findings.map((finding) => finding.type).sort()).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
    expect(
      result.findings
        .find((finding) => finding.type === "missing_evidence")
        ?.evidence.map((item) => item.documentId),
    ).toEqual(["tender", "voltline"]);

    const late = compareCompliance(tender, {
      extracted: {
        ...facts,
        programmeCompletionDate: fact(
          "2027-06-14",
          "arcwell",
          1,
          "Target practical completion: 14 June 2027.",
        ),
        commercialCompletionDate: null,
        insuranceEvidence: {
          publicLiability: fact(
            { status: "attached" as const, policyId: "SYN-PL-303" },
            "arcwell",
            3,
            "Public liability: synthetic policy SYN-PL-303; AUD 20 million.",
          ),
          workersCompensation: fact(
            { status: "attached" as const, policyId: "SYN-WC-303" },
            "arcwell",
            3,
            "Workers compensation: synthetic policy SYN-WC-303.",
          ),
        },
        supervisorQualification: fact(
          "Certificate III in Electrotechnology (2017)",
          "arcwell",
          2,
          "Supervisor qualification: Certificate III in Electrotechnology (2017).",
        ),
      },
      validation: { valid: true, errors: [] },
    });
    expect(late.findings.map((finding) => finding.type)).toEqual(["late_completion"]);
    expect(
      late.findings.some((finding) => (finding.type as string) === "expired_qualification"),
    ).toBe(false);
    expect(
      late.reviewCandidates.some((candidate) => candidate.topic === "qualification_validity"),
    ).toBe(true);

    const missingDate = compareCompliance(tender, {
      extracted: { ...facts, programmeCompletionDate: null },
      validation: { valid: true, errors: [] },
    });
    expect(missingDate.findings.some((finding) => finding.type === "late_completion")).toBe(false);
    expect(missingDate.reviewReasons).toContain(
      "Required or proposed practical completion date is missing.",
    );
    const invalid = compareCompliance(tender, {
      extracted: facts,
      validation: { valid: false, errors: ["bad citation"] },
    });
    expect(invalid.findings).toEqual([]);
    expect(invalid.status).toBe("requires_review");
  });

  it("keeps two mocked invocations, costs and raw responses without crossing prompts", async () => {
    const tender = await pdf("tender");
    const supplier = await pdf("voltline");
    const facts = await correctedVoltlineFacts();
    const tenderInvoke = vi.fn().mockResolvedValue({
      raw: raw("extract_tender_requirements", tenderFacts),
      parsed: tenderFacts,
    });
    const supplierInvoke = vi.fn().mockResolvedValue({
      raw: raw("extract_supplier_facts", facts),
      parsed: facts,
    });
    const report = await runAssessment(tender, supplier, tenderInvoke, supplierInvoke);
    expect(tenderInvoke).toHaveBeenCalledOnce();
    expect(supplierInvoke).toHaveBeenCalledOnce();
    expect(tenderInvoke.mock.calls[0]?.[0][1].text).not.toContain("Voltline Projects Pty Ltd");
    expect(supplierInvoke.mock.calls[0]?.[0][1].text).not.toContain(
      "Required practical completion: no later than",
    );
    expect(supplierInvoke.mock.calls[0]?.[0][1].text).not.toContain("reference.json");
    expect(report.tender.validation.valid).toBe(true);
    expect(report.supplier.validation.valid).toBe(true);
    const attempts = [...report.tender.attempts, ...report.supplier.attempts];
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.modelId)).toEqual([
      "amazon.nova-lite-v1:0",
      "amazon.nova-lite-v1:0",
    ]);
    expect(attempts.every((attempt) => attempt.rawResponse && attempt.tokenUsage)).toBe(true);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000378);
    const offline = evaluateAssessment(report, reference);
    expect(offline.factualAccuracy.passed).toBe(offline.factualAccuracy.total);
    expect(offline.complianceFindings.matches).toBe(true);
    expect(offline.citationValidity).toEqual({ tenderValid: true, supplierValid: true });
  });

  it("retains response metadata and cost when parsing fails, and records invocation errors", async () => {
    const tender = await pdf("tender");
    const supplier = await pdf("arcwell");
    const validTender = vi.fn().mockResolvedValue({
      raw: raw("extract_tender_requirements", tenderFacts),
      parsed: tenderFacts,
    });
    const literalNull = {
      ...(await correctedVoltlineFacts()),
      warranty: {
        value: { months: 24, conditions: "null" },
        evidence: [
          source("arcwell", 1, "Workmanship warranty: 12 months from practical completion."),
        ],
      },
    };
    const invalid = await runAssessment(
      tender,
      supplier,
      validTender,
      vi.fn().mockResolvedValue({
        raw: raw("extract_supplier_facts", literalNull),
        parsed: literalNull,
      }),
    );
    expect(invalid.supplier.extracted).toBeNull();
    expect(
      invalid.supplier.validation.errors.some((error) => error.includes("Use JSON null")),
    ).toBe(true);
    expect(invalid.supplier.attempts[0]?.rawResponse).toBeDefined();
    expect(invalid.totalEstimatedCostUsd).toBeCloseTo(0.000378);
    expect(invalid.assessment.findings).toEqual([]);

    const failed = await runAssessment(
      tender,
      supplier,
      validTender,
      vi.fn().mockRejectedValue(new Error("synthetic invocation failure")),
    );
    expect(failed.tender.attempts).toHaveLength(1);
    expect(failed.supplier.attempts[0]?.error).toBe("synthetic invocation failure");
    expect(failed.totalEstimatedCostUsd).toBeNull();
    expect(failed.assessment.status).toBe("requires_review");
  });
});
