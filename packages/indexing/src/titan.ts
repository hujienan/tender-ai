import { BedrockEmbeddings } from "@langchain/aws";
import { BEDROCK_REGION } from "../../bedrock/src/client.ts";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "./index.ts";

export const TITAN_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

export class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = TITAN_EMBEDDING_MODEL_ID;
  readonly region = BEDROCK_REGION;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly client: Pick<BedrockEmbeddings, "embedQuery">;

  constructor(
    client: Pick<BedrockEmbeddings, "embedQuery"> = new BedrockEmbeddings({
      model: TITAN_EMBEDDING_MODEL_ID,
      region: BEDROCK_REGION,
      dimensions: EMBEDDING_DIMENSIONS,
      modelParameters: { normalize: true },
      // An empty override keeps the SDK default credential chain even if a bearer token is in the environment.
      bedrockBearerToken: "",
    }),
  ) {
    this.client = client;
  }

  embed(text: string): Promise<number[]> {
    return this.client.embedQuery(text);
  }
}
