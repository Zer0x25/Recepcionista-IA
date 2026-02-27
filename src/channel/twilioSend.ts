/**
 * src/channel/twilioSend.ts
 *
 * Infrastructure adapter for sending WhatsApp messages via Twilio.
 *
 * Rules:
 * - No business logic here. This is pure infrastructure.
 * - No console.log. Pino only.
 * - No logging of message body content in production.
 * - Timeout enforced via Promise.race (TWILIO_SEND_TIMEOUT_MS).
 * - Throws on failure; caller handles retry/backoff.
 */

import twilio from "twilio";
import { logger } from "../observability/logger.js";
import { getTwilioEnv } from "../config/env.js";

const TWILIO_SEND_TIMEOUT_MS = 3_000;

export interface SendWhatsappMessageInput {
  to: string;
  from: string;
  body: string;
  /** Used as idempotency / correlation in logs only. */
  requestId: string;
  conversationId: string;
}

export interface SendWhatsappMessageResult {
  sid: string;
}

/**
 * Send a WhatsApp message via Twilio Messages API.
 *
 * @throws if env vars are missing, Twilio rejects, or timeout fires.
 */
export async function sendWhatsappMessage(
  input: SendWhatsappMessageInput,
): Promise<SendWhatsappMessageResult> {
  const { accountSid, authToken } = getTwilioEnv();
  const client = twilio(accountSid, authToken);

  const sendLogger = logger.child({
    requestId: input.requestId,
    conversationId: input.conversationId,
  });

  const startTime = Date.now();

  sendLogger.info({
    eventType: "TWILIO_SEND_STARTED",
    to_last4: input.to.slice(-4),
    from: input.from,
  });

  const sendPromise = client.messages.create({
    from: input.from,
    to: input.to,
    body: input.body,
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`Twilio send timed out after ${TWILIO_SEND_TIMEOUT_MS}ms`),
        ),
      TWILIO_SEND_TIMEOUT_MS,
    );
  });

  let sid: string;
  try {
    const message = await Promise.race([sendPromise, timeoutPromise]);
    sid = message.sid;
    const durationMs = Date.now() - startTime;

    sendLogger.info({
      eventType: "TWILIO_SEND_SUCCEEDED",
      durationMs,
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    sendLogger.error({
      eventType: "TWILIO_SEND_FAILED",
      durationMs,
      error: errorMsg,
    });

    throw err;
  }

  return { sid };
}
