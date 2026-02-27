import { z } from "zod";
/**
 * Validated input for the AI Adapter.
 */
export const AIInputSchema = z.object({
    conversationId: z.string().uuid().or(z.string().min(1)),
    requestId: z.string().uuid().or(z.string().min(1)),
    text: z.string().min(1),
    model: z.string().optional(),
});
/**
 * Validated output structure expected from the AI provider/bridge.
 */
export const AIOutputSchema = z.object({
    content: z.string(),
    tokensUsed: z.number().int().nonnegative(),
});
//# sourceMappingURL=types.js.map