import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { TwilioWebhookSchema } from "../validation/twilioSchema.js";
import { processIncomingMessage } from "../orchestrator/index.js";
import { State } from "@prisma/client";

import twilio from "twilio";
import { randomUUID } from "node:crypto";

async function verifyTwilioSignature(
  req: FastifyRequest,
  requestId?: string,
): Promise<boolean> {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"] as string;

  const requestLogger = requestId ? logger.child({ requestId }) : logger;

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_INSECURE_WEBHOOK === "true"
  ) {
    return true;
  }

  if (!twilioAuthToken || !signature) {
    requestLogger.warn({
      msg: "Twilio signature or auth token missing",
      hasSignature: !!signature,
      hasToken: !!twilioAuthToken,
      eventType: "WEBHOOK_SECURITY_DENIED",
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
    requestLogger.warn({
      msg: "Invalid Twilio signature",
      url,
      eventType: "WEBHOOK_SECURITY_DENIED",
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

      // 1. Validate signature
      const isValid = await verifyTwilioSignature(request, requestId);
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
            eventType: "WEBHOOK_DUPLICATE_IDEMPOTENCY",
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

        // Save message
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            providerMessageId,
            direction: "INBOUND",
            content,
            payload: request.body as any,
          },
        });

        // 5. Orchestration
        const finalState = await processIncomingMessage(
          conversation.id,
          providerMessageId,
          requestId,
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
