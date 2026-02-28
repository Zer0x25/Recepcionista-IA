import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { TwilioWebhookSchema } from "../validation/twilioSchema.js";
import { processIncomingMessage } from "../orchestrator/index.js";
import { Prisma } from "@prisma/client";

import twilio from "twilio";

async function verifyTwilioSignature(req: FastifyRequest, log: any): Promise<boolean> {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"] as string;

  if (process.env.NODE_ENV !== "production" && process.env.ALLOW_INSECURE_WEBHOOK === "true") {
    return true;
  }

  if (!twilioAuthToken || !signature) {
    log.warn({
      msg: "Twilio signature or auth token missing",
      hasSignature: !!signature,
      hasToken: !!twilioAuthToken,
      eventType: "WEBHOOK_REJECTED_INVALID_SIGNATURE",
    });
    return false;
  }

  // Construct the exact URL used by Twilio
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["host"];
  const url = `${protocol}://${host}${req.url}`;

  const isValid = (twilio as any).validateRequest(
    twilioAuthToken,
    signature,
    url,
    req.body as Record<string, any>,
  );

  if (!isValid) {
    log.warn({
      msg: "Invalid Twilio signature",
      url,
      eventType: "WEBHOOK_REJECTED_INVALID_SIGNATURE",
    });
  }

  return isValid;
}

export async function twilioWebhookHandler(fastify: FastifyInstance) {
  fastify.post("/webhooks/twilio", async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    const { requestId } = request;
    const requestLogger = logger.child({ requestId });

    const body = request.body as Record<string, any>;
    const safeFields = {
      providerMessageId: body.MessageSid,
      hasFrom: !!body.From,
      fromLast4: body.From ? String(body.From).slice(-4) : undefined,
      bodyLength: body.Body ? String(body.Body).length : 0,
      numMedia: Number(body.NumMedia) || 0,
      hasSignatureHeader: !!request.headers["x-twilio-signature"],
      path: request.url,
    };

    requestLogger.info({
      msg: "Webhook received",
      eventType: "WEBHOOK_RECEIVED",
      ...safeFields,
    });

    if (process.env.NODE_ENV === "development" && process.env.LOG_WEBHOOK_PAYLOAD === "true") {
      const debugPayload = { ...body };
      if (debugPayload.From) {
        debugPayload.From = `...${String(debugPayload.From).slice(-4)}`;
      }
      if (debugPayload.Body) {
        debugPayload.Body = `[redacted] (len: ${String(debugPayload.Body).length})`;
      }
      // Redact MediaUrl fields
      Object.keys(debugPayload).forEach((key) => {
        if (key.startsWith("MediaUrl")) {
          debugPayload[key] = "[redacted]";
        }
      });

      requestLogger.debug({
        msg: "Full webhook payload for debug (redacted)",
        eventType: "WEBHOOK_PAYLOAD_DEBUG",
        payload: debugPayload,
      });
    }

    // 1. Validate signature
    const isValid = await verifyTwilioSignature(request, requestLogger);
    if (!isValid) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    // 2. Validate payload
    const result = TwilioWebhookSchema.safeParse(request.body);
    if (!result.success) {
      requestLogger.error({
        msg: "Invalid Twilio payload",
        eventType: "WEBHOOK_VALIDATION_FAILED",
        ...safeFields,
        errors: result.error.format(),
        durationMs: Date.now() - startTime,
      });
      return reply.code(400).send({ error: "Invalid payload" });
    }

    const { MessageSid: providerMessageId, Body: content, From: fromNumber } = result.data;

    try {
      // 3. Idempotency Check
      const existingMessage = await prisma.message.findUnique({
        where: { providerMessageId },
      });

      if (existingMessage) {
        requestLogger.info({
          msg: "Duplicate message received",
          eventType: "WEBHOOK_IDEMPOTENT_HIT",
          providerMessageId,
          durationMs: Date.now() - startTime,
        });
        return reply.code(200).send("<Response></Response>");
      }

      // 4. Persistence
      // Find or create conversation
      const conversation = await prisma.conversation.upsert({
        where: { providerContact: fromNumber },
        update: {},
        create: { providerContact: fromNumber },
      });

      const contextualLogger = requestLogger.child({
        conversationId: conversation.id,
      });

      await processIncomingMessage(conversation.id, providerMessageId, requestId, {
        content,
        payload: request.body,
      });

      // 5. Return fast — AI reply is handled asynchronously by the worker
      contextualLogger.info({
        msg: "Inbound message accepted, job enqueued",
        eventType: "WEBHOOK_PROCESSED",
        providerMessageId,
        durationMs: Date.now() - startTime,
      });

      return reply.code(200).type("text/xml").send("<Response></Response>");
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        requestLogger.info({
          msg: "Concurrent idempotent hit (race condition)",
          eventType: "WEBHOOK_IDEMPOTENT_HIT",
          providerMessageId,
          durationMs: Date.now() - startTime,
        });
        return reply.code(200).send("<Response></Response>");
      }

      requestLogger.error({
        msg: "Error processing webhook",
        eventType: "WEBHOOK_ERROR",
        error: error instanceof Error ? error.message : String(error),
        providerMessageId,
        durationMs: Date.now() - startTime,
      });
      return reply.code(500).send({ error: "Internal Server Error" });
    }
  });
}
