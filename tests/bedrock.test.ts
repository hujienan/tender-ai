import { describe, expect, it } from "vitest";
import {
  BEDROCK_MODEL_ID,
  BEDROCK_REGION,
  NOVA_PRO_MODEL_ID,
  createBedrockClient,
} from "../packages/bedrock/src/client.ts";
import { estimateBedrockCost } from "../packages/bedrock/src/pricing.ts";

describe("Bedrock model configuration and pricing", () => {
  it("configures direct Nova Lite and Nova Pro in Sydney without explicit credentials", () => {
    const lite = createBedrockClient();
    expect(lite.model).toBe(BEDROCK_MODEL_ID);
    expect(lite.region).toBe(BEDROCK_REGION);
    const pro = createBedrockClient(4096, NOVA_PRO_MODEL_ID);
    expect(pro.model).toBe(NOVA_PRO_MODEL_ID);
    expect(pro.region).toBe(BEDROCK_REGION);
  });

  it("uses each direct model's configured rate and actual token counts", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(
      estimateBedrockCost(BEDROCK_MODEL_ID, BEDROCK_REGION, "default", usage).estimatedUsd,
    ).toBeCloseTo(0.315);
    const pro = estimateBedrockCost(NOVA_PRO_MODEL_ID, BEDROCK_REGION, "default", usage);
    expect(pro.estimatedUsd).toBeCloseTo(4.2);
    expect(pro.rate).toMatchObject({
      modelId: NOVA_PRO_MODEL_ID,
      inputUsdPerMillion: 0.84,
      outputUsdPerMillion: 3.36,
    });
  });

  it("refuses unsupported profiles, regions, tiers, cached tokens and invalid usage", () => {
    const usage = { input_tokens: 100, output_tokens: 50 };
    for (const model of ["apac.amazon.nova-lite-v1:0", "apac.amazon.nova-pro-v1:0"]) {
      expect(() => estimateBedrockCost(model, BEDROCK_REGION, "default", usage)).toThrow(
        "No configured price",
      );
    }
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
