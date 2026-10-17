import { ChatBedrockConverse } from "@langchain/aws";
import { performance } from "node:perf_hooks";

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
  });
}

export async function invokeBedrock(
  prompt: string,
  client: Pick<ChatBedrockConverse, "invoke"> = createBedrockClient(),
) {
  if (!prompt.trim()) throw new Error("Provide a non-empty prompt.");

  const started = performance.now();
  try {
    const response = await client.invoke(prompt);
    return {
      text: response.text,
      modelId: BEDROCK_MODEL_ID,
      latencyMs: Math.round(performance.now() - started),
      tokenUsage: response.usage_metadata ?? null,
      responseMetadata: response.response_metadata,
    };
  } catch (error) {
    throw bedrockError(error);
  }
}

function bedrockError(error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
      : undefined;

  if (
    name === "CredentialsProviderError" ||
    name === "UnrecognizedClientException" ||
    name === "ExpiredTokenException" ||
    name === "InvalidClientTokenId" ||
    name === "InvalidSignatureException" ||
    name === "SignatureDoesNotMatch" ||
    status === 401
  ) {
    return new Error("AWS authentication failed. Check the default AWS profile and credentials.", {
      cause: error,
    });
  }
  if (name === "AccessDeniedException" || status === 403) {
    return new Error(
      "Bedrock permission denied. Check model access and bedrock:InvokeModel permission.",
      {
        cause: error,
      },
    );
  }
  if (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "ProvisionedThroughputExceededException" ||
    name === "ServiceQuotaExceededException" ||
    status === 429
  ) {
    return new Error("Bedrock request was throttled. Retry after a short delay.", {
      cause: error,
    });
  }
  return new Error("Bedrock invocation failed. Check the model ID, region and request.", {
    cause: error,
  });
}
