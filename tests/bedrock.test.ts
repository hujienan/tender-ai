import { describe, expect, it, vi } from "vitest";
import {
  BEDROCK_MODEL_ID,
  BEDROCK_REGION,
  NOVA_PRO_MODEL_ID,
  createBedrockClient,
  invokeBedrock,
} from "../packages/bedrock/src/client.ts";

describe("Bedrock integration", () => {
  it("configures Nova Lite in Sydney without explicit credentials", () => {
    const client = createBedrockClient();
    expect(client.model).toBe(BEDROCK_MODEL_ID);
    expect(client.region).toBe(BEDROCK_REGION);
    const pro = createBedrockClient(4096, NOVA_PRO_MODEL_ID);
    expect(pro.model).toBe(NOVA_PRO_MODEL_ID);
    expect(pro.region).toBe(BEDROCK_REGION);
  });

  it("returns response text, latency, token usage and response metadata", async () => {
    const response = {
      text: "Hello from a mock model.",
      usage_metadata: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      response_metadata: { stopReason: "end_turn", requestId: "fake-request" },
    };
    const invoke = vi.fn().mockResolvedValue(response);

    const result = await invokeBedrock("Say hello", { invoke });

    expect(invoke).toHaveBeenCalledExactlyOnceWith("Say hello");
    expect(result).toMatchObject({
      text: "Hello from a mock model.",
      modelId: BEDROCK_MODEL_ID,
      tokenUsage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      responseMetadata: { stopReason: "end_turn", requestId: "fake-request" },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects empty prompts before invocation", async () => {
    const invoke = vi.fn();
    await expect(invokeBedrock("  ", { invoke })).rejects.toThrow("non-empty prompt");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["CredentialsProviderError", "authentication failed"],
    ["AccessDeniedException", "permission denied"],
    ["ThrottlingException", "throttled"],
    ["ValidationException", "invocation failed"],
  ])("explains %s failures", async (name, message) => {
    const error = Object.assign(new Error("SDK detail"), { name });
    const invoke = vi.fn().mockRejectedValue(error);
    await expect(invokeBedrock("Hello", { invoke })).rejects.toThrow(message);
  });
});
