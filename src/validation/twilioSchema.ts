import { z } from "zod";

export const TwilioWebhookSchema = z.object({
  MessageSid: z.string(),
  Body: z.string(),
  From: z.string(),
  To: z.string(),
  AccountSid: z.string(),
});

export type TwilioWebhookBody = z.infer<typeof TwilioWebhookSchema>;
