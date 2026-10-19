import { ChatBedrockConverse } from "@langchain/aws";

export const BEDROCK_MODEL_ID = "amazon.nova-lite-v1:0";
export const NOVA_PRO_MODEL_ID = "amazon.nova-pro-v1:0";
export const BEDROCK_REGION = "ap-southeast-2";
export type BedrockExtractionModelId = typeof BEDROCK_MODEL_ID | typeof NOVA_PRO_MODEL_ID;

export function createBedrockClient(
  maxTokens = 256,
  modelId: BedrockExtractionModelId = BEDROCK_MODEL_ID,
): ChatBedrockConverse {
  return new ChatBedrockConverse({
    model: modelId,
    region: BEDROCK_REGION,
    serviceTier: "default",
    maxTokens,
    ...(modelId === NOVA_PRO_MODEL_ID
      ? { additionalModelRequestFields: { inferenceConfig: { topK: 1 } } }
      : {}),
  });
}
