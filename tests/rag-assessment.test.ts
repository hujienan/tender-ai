import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import reference from "../datasets/electrical-installation/reference.json" with { type: "json" };
import { runTenderAssessment } from "../packages/assessment/src/run.ts";
import { BEDROCK_MODEL_ID } from "../packages/bedrock/src/client.ts";
import { evaluateAssessment } from "../packages/evaluation/src/evaluate.ts";
import {
  CHUNKER_VERSION,
  chunkDocument,
  documentContentHash,
} from "../packages/indexing/src/chunk.ts";
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type IndexedDocument,
} from "../packages/indexing/src/index.ts";
import { TITAN_EMBEDDING_MODEL_ID } from "../packages/indexing/src/titan.ts";
import { extractPdf, type ExtractedPdf } from "../packages/pdf/src/extract.ts";
import type { AssessmentRetrievalStore } from "../packages/assessment/src/retrieval-context.ts";
import {
  ComplianceRequirementsSchema,
  GeneralRequirementsSchema,
  type SupplierFacts,
} from "../packages/extraction/src/schema.ts";
import { fact, tenderFacts, voltlineFacts } from "./fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const vector = () => Array<number>(EMBEDDING_DIMENSIONS).fill(0.25);
const config = {
  modelId: TITAN_EMBEDDING_MODEL_ID,
  region: "ap-southeast-2",
  dimensions: EMBEDDING_DIMENSIONS,
};
const general = GeneralRequirementsSchema.parse({
  tenderId: tenderFacts.tenderId,
  closingDate: tenderFacts.closingDate,
  siteAccessDate: tenderFacts.siteAccessDate,
  requiredPracticalCompletionDate: tenderFacts.requiredPracticalCompletionDate,
  requiredCurrency: tenderFacts.requiredCurrency,
});
const compliance = ComplianceRequirementsSchema.parse({
  minimumComparableReferences: tenderFacts.minimumComparableReferences,
  publicLiabilityCertificateRequired: tenderFacts.publicLiabilityCertificateRequired,
  workersCompensationCertificateRequired: tenderFacts.workersCompensationCertificateRequired,
});

function response(name: string, args: Record<string, unknown>) {
  return {
    raw: Object.assign(
      new AIMessage({ content: "", tool_calls: [{ id: "test", name, args, type: "tool_call" }] }),
      { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ),
    parsed: args,
  };
}

function invokes(facts: SupplierFacts = voltlineFacts(), events: string[] = []) {
  return {
    general: vi.fn(async (_messages: BaseMessage[]) => {
      expect(_messages).toHaveLength(2);
      events.push("nova");
      return response("extract_tender_general", general);
    }),
    compliance: vi.fn(async (_messages: BaseMessage[]) => {
      expect(_messages).toHaveLength(2);
      events.push("nova");
      return response("extract_tender_compliance", compliance);
    }),
    supplier: vi.fn(async (_messages: BaseMessage[]) => {
      expect(_messages).toHaveLength(2);
      events.push("nova");
      return response("extract_supplier_facts", facts);
    }),
  };
}

function metadata(pdf: ExtractedPdf): IndexedDocument {
  return {
    documentId: pdf.documentId,
    sourceName: pdf.documentId + ".pdf",
    contentSha256: documentContentHash(pdf),
    pageCount: pdf.pages.length,
    chunkerVersion: CHUNKER_VERSION,
    embeddingModelId: config.modelId,
    embeddingRegion: config.region,
    embeddingDimensions: config.dimensions,
  };
}

function mockedRetrieval(
  tender: ExtractedPdf,
  supplier: ExtractedPdf,
  events: string[] = [],
  select?: (pdf: ExtractedPdf, call: number) => number[],
) {
  const documents = new Map([tender, supplier].map((pdf) => [pdf.documentId, pdf]));
  const provider: EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } = {
    ...config,
    embed: vi.fn(async () => {
      events.push("titan");
      return vector();
    }),
  };
  let tenderCalls = 0;
  let supplierCalls = 0;
  const store = {
    getDocument: vi.fn(async (id: string) => {
      events.push("metadata");
      const pdf = documents.get(id);
      return pdf ? metadata(pdf) : null;
    }),
    assertIndexed: vi.fn(async () => {}),
    search: vi.fn(async (ids: string[]) => {
      events.push("search");
      const pdf = documents.get(ids[0]!);
      if (!pdf) return [];
      const chunks = chunkDocument(pdf);
      const supplierDocument = pdf.documentId === supplier.documentId;
      const call = supplierDocument ? supplierCalls++ : tenderCalls++;
      const positions =
        select?.(pdf, call) ??
        (supplierDocument
          ? [
              [0, 1],
              [1, 2],
              [2, 0],
            ][call]!
          : [0, 1]);
      return positions.flatMap((position) => {
        const chunk = chunks[position];
        return chunk
          ? [
              {
                documentId: chunk.documentId,
                sourceName: metadata(pdf).sourceName,
                pageNumber: chunk.pageNumber,
                chunkIndex: chunk.chunkIndex,
                originalText: chunk.text,
                startOffset: chunk.startOffset,
                endOffset: chunk.endOffset,
                contentSha256: chunk.contentSha256,
                distance: position / 10,
              },
            ]
          : [];
      });
    }),
  } satisfies AssessmentRetrievalStore;
  return { provider, store };
}

async function fixturePdfs() {
  return Promise.all([
    extractPdf(join(root, "datasets/electrical-installation/pdfs/tender-request.pdf"), "tender"),
    extractPdf(
      join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"),
      "voltline",
    ),
  ]);
}

function twoPageScenario() {
  const tender: ExtractedPdf = {
    documentId: "tender",
    pages: [
      { page: 1, text: "Electrical installation scope and site walk-through." },
      {
        page: 2,
        text: "Tender ID: RAG-02. Required practical completion: no later than 1 May 2027. Attach current public liability and workers compensation insurance certificates.",
      },
    ],
  };
  const supplier: ExtractedPdf = {
    documentId: "voltline",
    pages: [{ page: 1, text: "Programme milestone practical completion: 17 May 2027." }],
  };
  const generalFacts = {
    tenderId: fact("RAG-02", "tender", 2, "Tender ID: RAG-02."),
    closingDate: null,
    siteAccessDate: null,
    requiredPracticalCompletionDate: fact(
      "2027-05-01",
      "tender",
      2,
      "Required practical completion: no later than 1 May 2027.",
    ),
    requiredCurrency: null,
  };
  const complianceFacts = {
    minimumComparableReferences: null,
    publicLiabilityCertificateRequired: fact(
      true,
      "tender",
      2,
      "Attach current public liability and workers compensation insurance certificates.",
    ),
    workersCompensationCertificateRequired: null,
  };
  const supplierFacts: SupplierFacts = {
    supplierName: null,
    priceExGst: null,
    currency: null,
    proposedDurationWeeks: null,
    warranty: null,
    programmeCompletionDate: fact(
      "2027-05-17",
      "voltline",
      1,
      "Programme milestone practical completion: 17 May 2027.",
    ),
    commercialCompletionDate: null,
    contractorLicence: null,
    supervisorQualification: null,
    comparableReferences: [],
    insuranceEvidence: { publicLiability: null, workersCompensation: null },
  };
  const calls = {
    general: vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_tender_general", generalFacts);
    }),
    compliance: vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_tender_compliance", complianceFacts);
    }),
    supplier: vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_supplier_facts", supplierFacts);
    }),
  };
  return { tender, supplier, generalFacts, complianceFacts, supplierFacts, calls };
}

describe("retrieval-grounded assessment", () => {
  it("keeps the full-document baseline and comparison unchanged", async () => {
    const [tender, supplier] = await fixturePdfs();
    const calls = invokes();
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
    );
    expect(report.mode).toBe("full");
    expect(report.schemaVersion).toBe(1);
    expect("retrieval" in report).toBe(false);
    expect(calls.supplier.mock.calls[0]?.[0]?.[1]?.text).toContain("Cover: workers compensation");
    expect(report.assessment.findings.map((finding) => finding.type).sort()).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
  });

  it("rejects page 2 tender citations when only page 1 reached Nova, blocking a late finding", async () => {
    const { tender, supplier, calls } = twoPageScenario();
    const { provider, store } = mockedRetrieval(tender, supplier, [], () => [0]);
    const rag = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(calls.general.mock.calls[0]?.[0]?.[1]?.text).not.toContain("Tender ID: RAG-02");
    expect(rag.tender.extracted.tenderId?.value).toBe("RAG-02");
    expect(rag.tender.validation.fields.tenderId?.status).toBe("invalid");
    expect(rag.tender.validation.fields.requiredPracticalCompletionDate?.status).toBe("invalid");
    expect(rag.tender.groups.general.validation.valid).toBe(false);
    expect(rag.supplier.validation.fields.programmeCompletionDate?.status).toBe("valid");
    expect(rag.assessment.findings.map((finding) => finding.type)).not.toContain("late_completion");
    expect(rag.assessment.status).toBe("requires_review");

    const full = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
    );
    expect(full.tender.validation.fields.tenderId?.status).toBe("valid");
    expect(full.tender.validation.fields.requiredPracticalCompletionDate?.status).toBe("valid");
    expect(full.assessment.findings.map((finding) => finding.type)).toContain("late_completion");
  });

  it("keeps tender general and compliance passage allowlists separate", async () => {
    const { tender, supplier, calls } = twoPageScenario();
    const { provider, store } = mockedRetrieval(tender, supplier, [], (pdf, call) =>
      pdf.documentId === "tender" && call >= 2 ? [1] : [0],
    );
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(calls.general.mock.calls[0]?.[0]?.[1]?.text).not.toContain("Tender ID: RAG-02");
    expect(calls.compliance.mock.calls[0]?.[0]?.[1]?.text).toContain(
      "Attach current public liability",
    );
    expect(report.tender.validation.fields.tenderId?.status).toBe("invalid");
    expect(report.tender.validation.fields.publicLiabilityCertificateRequired?.status).toBe(
      "valid",
    );
    expect(report.tender.groups.compliance.validation.valid).toBe(true);
  });

  it("keeps supplier citations within supplier retrieval context", async () => {
    const { tender, supplier, calls, supplierFacts } = twoPageScenario();
    supplier.pages.push({ page: 2, text: "Price excluding GST: AUD 950,000." });
    supplierFacts.priceExGst = fact(950000, "voltline", 2, "Price excluding GST: AUD 950,000.");
    const { provider, store } = mockedRetrieval(tender, supplier, [], (pdf) =>
      pdf.documentId === "voltline" ? [0] : [1],
    );
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(report.supplier.validation.fields.priceExGst?.status).toBe("invalid");
    expect(report.supplier.validation.fields.programmeCompletionDate?.status).toBe("valid");
    expect(report.assessment.status).toBe("requires_review");
  });

  it("marks a recovered but unprovided tender citation invalid", async () => {
    const { tender, supplier, generalFacts, calls } = twoPageScenario();
    calls.general
      .mockReset()
      .mockResolvedValueOnce(
        response("extract_tender_general", { tenderId: generalFacts.tenderId }),
      )
      .mockRejectedValueOnce(new Error("ToolUse failed"));
    const { provider, store } = mockedRetrieval(tender, supplier, [], () => [0]);
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(report.tender.groups.general.recovery?.retried).toBe(true);
    expect(report.tender.groups.general.recovery?.recoveredFields.tenderId).toBeUndefined();
    expect(report.tender.extracted.tenderId).toBeNull();
    expect(report.tender.validation.fields.tenderId?.status).toBe("invalid");
    expect(report.tender.groups.general.validation.valid).toBe(false);
    expect(report.assessment.status).toBe("requires_review");
  });

  it("selects an in-context retry over an unsupported recovery candidate", async () => {
    const { tender, supplier, generalFacts, calls } = twoPageScenario();
    tender.pages[0]!.text += " Tender ID: RAG-01.";
    const available = fact("RAG-01", "tender", 1, "Tender ID: RAG-01.");
    calls.general
      .mockReset()
      .mockResolvedValueOnce(
        response("extract_tender_general", { tenderId: generalFacts.tenderId }),
      )
      .mockResolvedValueOnce(response("extract_tender_general", { tenderId: available }));
    const { provider, store } = mockedRetrieval(tender, supplier, [], () => [0]);
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(report.tender.extracted.tenderId?.value).toBe("RAG-01");
    expect(report.tender.validation.fields.tenderId?.status).toBe("valid");
    expect(report.tender.groups.general.recovery?.recoveredFields.tenderId?.attempt).toBe(2);
    expect(report.tender.groups.general.recovery?.fieldErrors.tenderId).toBeUndefined();
  });

  it("retrieves role-scoped passages before Nova and preserves original-PDF validation", async () => {
    const [tender, supplier] = await fixturePdfs();
    const events: string[] = [];
    const { provider, store } = mockedRetrieval(tender, supplier, events);
    const calls = invokes(voltlineFacts(), events);
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(events.slice(0, 2)).toEqual(["metadata", "metadata"]);
    expect(store.assertIndexed).toHaveBeenCalledWith(["tender", "voltline"], provider);
    expect(events.indexOf("nova")).toBeGreaterThan(events.lastIndexOf("search"));
    expect(provider.embed).toHaveBeenCalledTimes(7);
    expect(report.mode).toBe("rag");
    expect(report.schemaVersion).toBe(1);
    expect(report.retrieval?.embeddingRequests).toBe(7);
    expect(report.retrieval?.distinctChunkCount).toBe(5);
    expect(report.retrieval?.groupChunkCounts).toEqual({ general: 2, compliance: 2, supplier: 3 });
    expect(report.retrieval?.queries.map((entry) => entry.group)).toEqual([
      "general",
      "general",
      "compliance",
      "compliance",
      "supplier",
      "supplier",
      "supplier",
    ]);
    expect(
      report.retrieval?.queries.every(
        (entry) => entry.documentIds[0] === (entry.group === "supplier" ? "voltline" : "tender"),
      ),
    ).toBe(true);
    expect(report.retrieval?.queries[0]?.chunks[0]).toEqual({
      documentId: "tender",
      pageNumber: 1,
      chunkIndex: 0,
    });
    const generalPrompt = calls.general.mock.calls[0]?.[0]?.[1]?.text ?? "";
    const compliancePrompt = calls.compliance.mock.calls[0]?.[0]?.[1]?.text ?? "";
    const supplierPrompt = calls.supplier.mock.calls[0]?.[0]?.[1]?.text ?? "";
    expect(generalPrompt).toContain("Document ID: tender");
    expect(compliancePrompt).toContain("Document ID: tender");
    expect(generalPrompt).not.toContain("Voltline Projects");
    expect(compliancePrompt).not.toContain("Voltline Projects");
    expect(supplierPrompt).toContain("Document ID: voltline");
    expect(supplierPrompt).not.toContain("Tender closes:");
    expect(supplierPrompt.match(/\[Page 2, Chunk 1\]/g)).toHaveLength(1);
    expect(supplierPrompt).not.toContain("reference.json");
    expect(report.supplier.extracted?.programmeCompletionDate?.value).toBe("2027-05-17");
    expect(report.supplier.extracted?.commercialCompletionDate?.value).toBe("2027-05-21");
    expect(report.assessment.findings.map((finding) => finding.type).sort()).toEqual([
      "conflicting_dates",
      "missing_evidence",
    ]);
    expect(evaluateAssessment(report, reference).factualAccuracy.passed).toBeGreaterThan(0);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.00000567);
    for (const command of ["revalidate", "evaluate"]) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", join(root, "scripts", command + ".ts"), "/dev/stdin"],
        { input: JSON.stringify(report), encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const saved = JSON.parse(result.stdout) as Record<string, unknown>;
      if (command === "revalidate") expect(saved.mode).toBe("rag");
      else expect(saved.factualAccuracy).toBeTruthy();
    }
  });

  it("revalidates saved RAG citations against recorded chunks and original PDFs offline", async () => {
    const [tender, supplier] = await fixturePdfs();
    const { provider, store } = mockedRetrieval(tender, supplier, [], (pdf, call) =>
      pdf.documentId === "tender"
        ? [0]
        : [
            [0, 1],
            [1, 2],
            [2, 0],
          ][call]!,
    );
    const calls = invokes();
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(report.tender.validation.fields.publicLiabilityCertificateRequired?.status).toBe(
      "invalid",
    );
    const saved = JSON.parse(JSON.stringify(report)) as typeof report;
    saved.tender.validation.valid = true;
    saved.tender.groups.compliance.validation.valid = true;
    const revalidated = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(root, "scripts/revalidate.ts"), "/dev/stdin"],
      { input: JSON.stringify(saved), encoding: "utf8" },
    );
    expect(revalidated.status, revalidated.stderr).toBe(0);
    const checked = JSON.parse(revalidated.stdout) as typeof report;
    expect(checked.mode).toBe("rag");
    expect(checked.tender.validation.fields.publicLiabilityCertificateRequired?.status).toBe(
      "invalid",
    );
    expect(checked.tender.groups.compliance.validation.valid).toBe(false);
    expect(checked.assessment.findings.map((finding) => finding.type)).not.toContain(
      "missing_evidence",
    );
    const evaluated = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(root, "scripts/evaluate.ts"), "/dev/stdin"],
      { input: revalidated.stdout, encoding: "utf8" },
    );
    expect(evaluated.status, evaluated.stderr).toBe(0);
    expect(JSON.parse(evaluated.stdout).overallResult).toBe("requires_review");
  });

  it.each([
    {
      group: "general" as const,
      recovered: "tenderId",
      unresolved: "closingDate",
      tool: "extract_tender_general",
      value: tenderFacts.tenderId,
    },
    {
      group: "compliance" as const,
      recovered: "minimumComparableReferences",
      unresolved: "publicLiabilityCertificateRequired",
      tool: "extract_tender_compliance",
      value: tenderFacts.minimumComparableReferences,
    },
  ])(
    "keeps unresolved $group recovery errors during offline RAG revalidation",
    async ({ group, recovered, unresolved, tool, value }) => {
      const [tender, supplier] = await fixturePdfs();
      const { provider, store } = mockedRetrieval(tender, supplier);
      const calls = invokes();
      calls[group]
        .mockReset()
        .mockResolvedValueOnce(response(tool, { [recovered]: value }))
        .mockRejectedValueOnce(new Error("ToolUse failed"));
      const report = await runTenderAssessment(
        tender,
        supplier,
        calls.general,
        calls.compliance,
        calls.supplier,
        BEDROCK_MODEL_ID,
        { mode: "rag", embeddingProvider: provider, retrievalStore: store },
      );
      expect(report.tender.groups[group].recovery?.recoveredFields[recovered]).toBeDefined();
      expect(report.tender.groups[group].recovery?.fieldErrors[unresolved]).toBeDefined();
      expect(report.tender.groups[group].validation.valid).toBe(false);

      const saved = JSON.parse(JSON.stringify(report)) as typeof report;
      saved.tender.groups[group].validation.valid = true;
      const revalidated = spawnSync(
        process.execPath,
        ["--experimental-strip-types", join(root, "scripts/revalidate.ts"), "/dev/stdin"],
        { input: JSON.stringify(saved), encoding: "utf8" },
      );
      expect(revalidated.status, revalidated.stderr).toBe(0);
      const checked = JSON.parse(revalidated.stdout) as typeof report;
      expect(checked.tender.groups[group].validation.valid).toBe(false);
      expect(checked.tender.groups[group].validation.errors).toEqual(
        expect.arrayContaining(report.tender.groups[group].recovery!.fieldErrors[unresolved]!),
      );
      expect(checked.tender.validation.fields[unresolved]?.status).toBe("invalid");
      expect(checked.tender.validation.fields[recovered]?.status).toBe("valid");
      expect(checked.assessment.findings.map((finding) => finding.type)).toContain(
        "conflicting_dates",
      );
    },
  );

  it("never puts an unselected source passage into a RAG prompt", async () => {
    const tender: ExtractedPdf = {
      documentId: "tender",
      pages: [
        { page: 1, text: "Visible tender text." },
        { page: 2, text: "HIDDEN TENDER PASSAGE." },
      ],
    };
    const supplier: ExtractedPdf = {
      documentId: "voltline",
      pages: [
        { page: 1, text: "Visible supplier text." },
        { page: 2, text: "HIDDEN SUPPLIER PASSAGE." },
      ],
    };
    const { provider, store } = mockedRetrieval(tender, supplier, [], () => [0]);
    const emptyGeneral = {
      tenderId: null,
      closingDate: null,
      siteAccessDate: null,
      requiredPracticalCompletionDate: null,
      requiredCurrency: null,
    };
    const emptyCompliance = {
      minimumComparableReferences: null,
      publicLiabilityCertificateRequired: null,
      workersCompensationCertificateRequired: null,
    };
    const emptySupplier = {
      supplierName: null,
      priceExGst: null,
      currency: null,
      proposedDurationWeeks: null,
      warranty: null,
      programmeCompletionDate: null,
      commercialCompletionDate: null,
      contractorLicence: null,
      supervisorQualification: null,
      comparableReferences: [],
      insuranceEvidence: { publicLiability: null, workersCompensation: null },
    };
    const generalInvoke = vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_tender_general", emptyGeneral);
    });
    const complianceInvoke = vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_tender_compliance", emptyCompliance);
    });
    const supplierInvoke = vi.fn(async (messages: BaseMessage[]) => {
      expect(messages).toHaveLength(2);
      return response("extract_supplier_facts", emptySupplier);
    });
    await runTenderAssessment(
      tender,
      supplier,
      generalInvoke,
      complianceInvoke,
      supplierInvoke,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(generalInvoke.mock.calls[0]?.[0]?.[1]?.text).not.toContain("HIDDEN TENDER PASSAGE");
    expect(complianceInvoke.mock.calls[0]?.[0]?.[1]?.text).not.toContain("HIDDEN TENDER PASSAGE");
    expect(supplierInvoke.mock.calls[0]?.[0]?.[1]?.text).not.toContain("HIDDEN SUPPLIER PASSAGE");
  });

  it("keeps unsupported duration evidence unresolved without conflating completion dates", async () => {
    const [tender, supplier] = await fixturePdfs();
    const facts = voltlineFacts();
    facts.proposedDurationWeeks!.evidence = facts.commercialCompletionDate!.evidence;
    const calls = invokes(facts);
    const { provider, store } = mockedRetrieval(tender, supplier);
    const report = await runTenderAssessment(
      tender,
      supplier,
      calls.general,
      calls.compliance,
      calls.supplier,
      BEDROCK_MODEL_ID,
      { mode: "rag", embeddingProvider: provider, retrievalStore: store },
    );
    expect(report.supplier.validation.fields.proposedDurationWeeks?.status).toBe("invalid");
    expect(report.supplier.validation.fields.programmeCompletionDate?.status).toBe("valid");
    expect(report.supplier.validation.fields.commercialCompletionDate?.status).toBe("valid");
    expect(report.assessment.findings.map((finding) => finding.type)).toContain(
      "conflicting_dates",
    );
    expect(report.assessment.status).toBe("requires_review");
  });

  it.each(["missing", "stale", "incompatible"])(
    "fails on %s indexed metadata before billable inference",
    async (problem) => {
      const [tender, supplier] = await fixturePdfs();
      const { provider, store } = mockedRetrieval(tender, supplier);
      const original = store.getDocument;
      store.getDocument = vi.fn(async (id: string) => {
        const found = await original(id);
        if (id !== "voltline") return found;
        if (problem === "missing") return null;
        if (problem === "stale") return { ...found!, contentSha256: "0".repeat(64) };
        return { ...found!, embeddingModelId: "mock:offline-smoke" };
      });
      const calls = invokes();
      await expect(
        runTenderAssessment(
          tender,
          supplier,
          calls.general,
          calls.compliance,
          calls.supplier,
          BEDROCK_MODEL_ID,
          { mode: "rag", embeddingProvider: provider, retrievalStore: store },
        ),
      ).rejects.toThrow(
        problem === "missing"
          ? "not indexed"
          : problem === "stale"
            ? "changed since indexing"
            : "incompatible embeddings",
      );
      expect(provider.embed).not.toHaveBeenCalled();
      expect(calls.general).not.toHaveBeenCalled();
      expect(store.search).not.toHaveBeenCalled();
    },
  );

  it("fails clearly on retrieval errors or empty contexts without calling Nova", async () => {
    const [tender, supplier] = await fixturePdfs();
    const { provider, store } = mockedRetrieval(tender, supplier);
    const calls = invokes();
    store.assertIndexed.mockRejectedValueOnce(new Error("Supplier chunks are not indexed"));
    await expect(
      runTenderAssessment(
        tender,
        supplier,
        calls.general,
        calls.compliance,
        calls.supplier,
        BEDROCK_MODEL_ID,
        { mode: "rag", embeddingProvider: provider, retrievalStore: store },
      ),
    ).rejects.toThrow("Supplier chunks are not indexed");
    expect(provider.embed).not.toHaveBeenCalled();
    expect(calls.general).not.toHaveBeenCalled();
    store.search.mockRejectedValueOnce(new Error("PostgreSQL unavailable"));
    await expect(
      runTenderAssessment(
        tender,
        supplier,
        calls.general,
        calls.compliance,
        calls.supplier,
        BEDROCK_MODEL_ID,
        { mode: "rag", embeddingProvider: provider, retrievalStore: store },
      ),
    ).rejects.toThrow("PostgreSQL unavailable");
    expect(calls.general).not.toHaveBeenCalled();
    store.search.mockReset().mockResolvedValue([]);
    await expect(
      runTenderAssessment(
        tender,
        supplier,
        calls.general,
        calls.compliance,
        calls.supplier,
        BEDROCK_MODEL_ID,
        { mode: "rag", embeddingProvider: provider, retrievalStore: store },
      ),
    ).rejects.toThrow("No retrieved passages for general");
    expect(calls.general).not.toHaveBeenCalled();
  });

  it("rejects a retrieved passage that differs from the original PDF", async () => {
    const [tender, supplier] = await fixturePdfs();
    const { provider, store } = mockedRetrieval(tender, supplier);
    const original = store.search;
    store.search = vi.fn(async (ids: string[]) => {
      const results = await original(ids);
      return results.map((result, index) =>
        index === 0 ? { ...result, originalText: result.originalText + " altered" } : result,
      );
    });
    const calls = invokes();
    await expect(
      runTenderAssessment(
        tender,
        supplier,
        calls.general,
        calls.compliance,
        calls.supplier,
        BEDROCK_MODEL_ID,
        { mode: "rag", embeddingProvider: provider, retrievalStore: store },
      ),
    ).rejects.toThrow("differs from the source PDF");
    expect(calls.general).not.toHaveBeenCalled();
  });
});
