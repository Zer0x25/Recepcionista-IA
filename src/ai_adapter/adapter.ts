import { logger } from "../observability/logger";
import {
  AIInput,
  AIInputSchema,
  AIOutputSchema,
  AIAdapterResponse,
} from "./types";

/**
 * AI Adapter - Non-authoritative wrapper for AI calls.
 * Implements rigid contract and token usage logging.
 */
export async function callAI(input: AIInput): Promise<AIAdapterResponse> {
  const startTime = Date.now();
  const { requestId, conversationId, model = "stub-model" } = input;

  try {
    // 1. Validate Input
    const validatedInput = AIInputSchema.parse(input);

    // 2. Log Start
    logger.info({
      eventType: "AI_CALL_STARTED",
      requestId,
      conversationId,
      model,
    });

    // 3. AI Provider Call (Stub for now)
    // In a real implementation, this would call OpenAI/Anthropic/etc.
    const rawOutput = await aiProviderStub(validatedInput.text);

    // 4. Validate Output
    const validatedOutput = AIOutputSchema.parse(rawOutput);

    const durationMs = Date.now() - startTime;

    // 5. Log Success
    logger.info({
      eventType: "AI_CALL_SUCCEEDED",
      requestId,
      conversationId,
      model,
      tokensUsed: validatedOutput.tokensUsed,
      durationMs,
    });

    return {
      success: true,
      content: validatedOutput.content,
      tokensUsed: validatedOutput.tokensUsed,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;

    // 6. Log Failure
    logger.error({
      eventType: "AI_CALL_FAILED",
      requestId,
      conversationId,
      model,
      durationMs,
      error: error.message,
    });

    // 7. Fallback Seguro
    return {
      success: false,
      content: "",
      tokensUsed: 0,
      error: error.message,
    };
  }
}

/**
 * Temporary stub for AI provider.
 */
async function aiProviderStub(text: string): Promise<any> {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    content: `AI response to: ${text}`,
    tokensUsed: Math.floor(text.length / 4) + 10,
  };
}
