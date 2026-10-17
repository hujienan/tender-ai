import { invokeBedrock } from "../packages/bedrock/src/client.ts";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: pnpm bedrock:demo "Your prompt"');
  process.exitCode = 1;
} else {
  try {
    const result = await invokeBedrock(prompt);
    console.log(result.text);
    console.log(
      JSON.stringify(
        {
          modelId: result.modelId,
          latencyMs: result.latencyMs,
          tokenUsage: result.tokenUsage,
          responseMetadata: result.responseMetadata,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bedrock invocation failed.");
    process.exitCode = 1;
  }
}
