import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatBedrockConverse } from "@langchain/aws";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { extractSupplierFacts } from "../packages/extraction/src/facts.ts";
import { SupplierFactsToolSchema } from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import { voltlineFacts } from "./fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const supplierPdf = () =>
  extractPdf(join(root, "datasets/electrical-installation/pdfs/voltline-proposal.pdf"), "voltline");

function raw(...args: Record<string, unknown>[]) {
  const message = new AIMessage({
    content: "",
    tool_calls: args.map((value, index) => ({
      id: `call-${index + 1}`,
      name: "extract_supplier_facts",
      args: value,
      type: "tool_call" as const,
    })),
  });
  message.response_metadata = { serviceTier: "default", requestId: "mock-request" };
  Object.assign(message, {
    usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
  });
  return message;
}

describe("structured supplier invocation", () => {
  it("retains validated facts, source boundaries, usage and cost from a mocked response", async () => {
    const facts = voltlineFacts();
    const invoke = vi.fn().mockResolvedValue({ raw: raw(facts), parsed: facts });
    const report = await extractSupplierFacts(await supplierPdf(), invoke);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0][0].text).toContain("untrusted data");
    expect(invoke.mock.calls[0]?.[0][1].text).toContain("[Page 3]");
    expect(invoke.mock.calls[0]?.[0][1].text).not.toContain("reference.json");
    expect(report.validation.valid).toBe(true);
    expect(report.extracted).toEqual(facts);
    expect(report.attempts[0]?.responseMetadata.requestId).toBe("mock-request");
    expect(report.attempts[0]?.tokenUsage?.input_tokens).toBe(1000);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.000189);
  });

  it("rejects partial and malformed outputs while preserving raw response and cost", async () => {
    const pdf = await supplierPdf();
    const partial = { supplierName: voltlineFacts().supplierName };
    const incomplete = await extractSupplierFacts(
      pdf,
      vi.fn().mockResolvedValue({
        raw: raw(partial, { priceExGst: voltlineFacts().priceExGst }),
        parsed: partial,
      }),
    );
    expect(incomplete.extracted).toBeNull();
    expect(incomplete.validation.errors.join(" ")).toContain(
      "Expected one extract_supplier_facts tool call",
    );
    expect(incomplete.validation.errors.join(" ")).toContain(
      "Incomplete extract_supplier_facts object",
    );
    expect(incomplete.attempts[0]?.rawResponse?.tool_calls).toHaveLength(2);
    expect(incomplete.totalEstimatedCostUsd).toBeCloseTo(0.000189);

    const invalidDate = {
      ...voltlineFacts(),
      programmeCompletionDate: {
        ...voltlineFacts().programmeCompletionDate!,
        value: "17 May 2027",
      },
    };
    const malformed = await extractSupplierFacts(
      pdf,
      vi.fn().mockResolvedValue({ raw: raw(invalidDate), parsed: invalidDate }),
    );
    expect(malformed.extracted).toBeNull();
    expect(malformed.validation.errors.join(" ")).toContain("programmeCompletionDate");
    expect(malformed.attempts[0]?.rawResponse).toBeDefined();
    expect(malformed.totalEstimatedCostUsd).toBeCloseTo(0.000189);
  });

  it("configures LangChain structured output with the current schema without calling AWS", async () => {
    expect(SupplierFactsToolSchema.required).toEqual(
      Object.keys(SupplierFactsToolSchema.properties ?? {}),
    );
    expect(JSON.stringify(SupplierFactsToolSchema)).toContain('"format":"date"');
    const invoke = vi.fn().mockResolvedValue({ raw: raw(), parsed: null });
    const structured = vi
      .spyOn(ChatBedrockConverse.prototype, "withStructuredOutput")
      .mockReturnValue({ invoke } as never);
    try {
      await extractSupplierFacts({
        documentId: "voltline",
        pages: [{ page: 1, text: "synthetic" }],
      });
      expect(structured).toHaveBeenCalledWith(SupplierFactsToolSchema, {
        name: "extract_supplier_facts",
        includeRaw: true,
      });
      expect(JSON.stringify(structured.mock.calls[0]?.[0])).toContain(
        "Explicitly labelled insurance policy or certificate identifier only; a coverage amount is not an identifier. Use JSON null when no identifier is provided.",
      );
      const configured = structured.mock.contexts[0] as ChatBedrockConverse;
      expect(configured.supportsToolChoiceValues).toEqual(["tool"]);
      expect(configured.temperature).toBe(0);
      expect(Object.keys(SupplierFactsToolSchema)).toEqual(["type", "properties", "required"]);
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      structured.mockRestore();
    }
  });
});
