import { BEDROCK_MODEL_ID, BEDROCK_REGION, NOVA_PRO_MODEL_ID } from "./client.ts";

// AWS public Price List, Sydney on-demand Nova Lite SKUs VE26ZEBZ95PNKV6H and 8QD3UNYB3WE6E2YA; verified 2026-10-16.
export const NOVA_LITE_SYDNEY_RATE = {
  modelId: BEDROCK_MODEL_ID,
  region: BEDROCK_REGION,
  serviceTier: "default",
  inputUsdPerMillion: 0.063,
  outputUsdPerMillion: 0.252,
  source:
    "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-southeast-2/index.json",
  verifiedDate: "2026-10-16",
} as const;

// AWS public Price List, Sydney on-demand Nova Pro SKUs GYXPG7Q84HT36QA9 and 87XC7TRUVX2ECEK7; verified 2026-10-17.
export const NOVA_PRO_SYDNEY_RATE = {
  modelId: NOVA_PRO_MODEL_ID,
  region: BEDROCK_REGION,
  serviceTier: "default",
  inputUsdPerMillion: 0.84,
  outputUsdPerMillion: 3.36,
  source:
    "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-southeast-2/index.json",
  verifiedDate: "2026-10-17",
} as const;

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
};

export function estimateBedrockCost(
  modelId: string,
  region: string,
  serviceTier: string,
  usage: TokenUsage,
) {
  const rate = [NOVA_LITE_SYDNEY_RATE, NOVA_PRO_SYDNEY_RATE].find(
    (candidate) =>
      modelId === candidate.modelId &&
      region === candidate.region &&
      serviceTier === candidate.serviceTier,
  );
  if (!rate) {
    throw new Error("No configured price for this model ID, region and service tier.");
  }
  if (
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    throw new Error("Valid input and output token counts are required for a cost estimate.");
  }
  const cacheRead = usage.input_token_details?.cache_read ?? 0;
  const cacheCreation = usage.input_token_details?.cache_creation ?? 0;
  if (
    !Number.isSafeInteger(cacheRead) ||
    cacheRead < 0 ||
    !Number.isSafeInteger(cacheCreation) ||
    cacheCreation < 0
  ) {
    throw new Error("Valid cached token counts are required for a cost estimate.");
  }
  if (cacheRead > 0 || cacheCreation > 0) {
    throw new Error("Cached tokens need separate rates; cost estimate is unavailable.");
  }
  return {
    currency: "USD" as const,
    estimatedUsd:
      (usage.input_tokens * rate.inputUsdPerMillion +
        usage.output_tokens * rate.outputUsdPerMillion) /
      1_000_000,
    rate,
  };
}
