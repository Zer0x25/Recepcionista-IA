import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { TwilioWebhookSchema } from "../validation/twilioSchema.js";
import { processIncomingMessage } from "../orchestrator/index.js";
import { State } from "@prisma/client";

async function verifyTwilioSignature(req: FastifyRequest): Promise<boolean> {
  // STUB: Verify signature if TWILIO_AUTH_TOKEN is present in headers/env
  // For now, return true to allow development
  const signature = req.headers["x-twilio-signature"];
  if (!signature) {
    logger.warn({ msg: "Twilio signature missing" });
    return process.env.NODE_ENV !== "production";
  }
  return true;
}

export async function twilioWebhookHandler(fastify: FastifyInstance) {
  fastify.post(
    "/webhooks/twilio",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = Date.now();

      // 1. Validate signature
      const isValid = await verifyTwilioSignature(request);
      if (!isValid) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      // 2. Validate payload
      const result = TwilioWebhookSchema.safeParse(request.body);
      if (!result.success) {
        logger.error({
          msg: "Invalid Twilio payload",
          errors: result.error.format(),
          payload: request.body,
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
          logger.info({
            msg: "Duplicate message received",
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
        );

        // 6. Response Construction
        // If HANDOFF, we don't send any automatic response (human will take over)
        if (finalState === State.HANDOFF) {
          logger.info({
            msg: "Suppressing automatic response due to HANDOFF state",
            conversationId: conversation.id,
            providerMessageId,
          });
          return reply.code(200).type("text/xml").send("<Response></Response>");
        }

        logger.info({
          msg: "Message processed successfully",
          eventType: "WEBHOOK_RECEIVED",
          conversationId: conversation.id,
          providerMessageId,
          durationMs: Date.now() - startTime,
        });

        return reply
          .code(200)
          .type("text/xml")
          .send(
            `<Response><Message>Placeholder: Recibido (Estado: ${finalState})</Message></Response>`,
          );
      } catch (error) {
        logger.error({
          msg: "Error processing webhook",
          error: error instanceof Error ? error.message : String(error),
          providerMessageId,
        });
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );
}
