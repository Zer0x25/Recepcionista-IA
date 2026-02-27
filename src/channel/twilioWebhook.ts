import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { TwilioWebhookSchema } from "../validation/twilioSchema.js";
import { processIncomingMessage } from "../orchestrator/index.js";
import { State, Prisma } from "@prisma/client";

import twilio from "twilio";
import { randomUUID } from "node:crypto";

async function verifyTwilioSignature(
  req: FastifyRequest,
  log: any,
): Promise<boolean> {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"] as string;

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_INSECURE_WEBHOOK === "true"
  ) {
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
  fastify.post(
    "/webhooks/twilio",
    async (request: FastifyRequest, reply: FastifyReply) => {
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

      if (
        process.env.NODE_ENV !== "production" &&
        process.env.LOG_WEBHOOK_PAYLOAD === "true"
      ) {
        requestLogger.debug({
          msg: "Full webhook payload for debug",
          eventType: "WEBHOOK_PAYLOAD_DEBUG",
          payload: request.body,
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
          errors: result.error.format(),
          payload: request.body,
          durationMs: Date.now() - startTime,
        });
        return reply.code(400).send({ error: "Invalid payload" });
      }

      const {
        MessageSid: providerMessageId,
        Body: content,
        From: fromNumber,
      } = result.data;

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

        const finalState = await processIncomingMessage(
          conversation.id,
          providerMessageId,
          requestId,
          {
            content,
            payload: request.body,
          },
        );

        // 6. Response Construction & Persistence
        const outboundProviderMessageId = `internal-${randomUUID()}`;
        let responseContent = "";
        let twiml = "";

        if (finalState === State.HANDOFF) {
          contextualLogger.info({
            msg: "Suppressing automatic response due to HANDOFF state",
            eventType: "WEBHOOK_PROCESSED",
            providerMessageId,
            durationMs: Date.now() - startTime,
          });
          twiml = "<Response></Response>";
        } else {
          responseContent = `Placeholder: Recibido (Estado: ${finalState})`;
          twiml = `<Response><Message>${responseContent}</Message></Response>`;

          // Persist OUTBOUND message
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              providerMessageId: outboundProviderMessageId,
              direction: "OUTBOUND",
              content: responseContent,
              payload: { twiml } as any,
            },
          });

          contextualLogger.info({
            msg: "Message processed successfully",
            eventType: "WEBHOOK_PROCESSED",
            providerMessageId,
            outboundProviderMessageId,
            durationMs: Date.now() - startTime,
          });
        }

        return reply.code(200).type("text/xml").send(twiml);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
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
    },
  );
}
