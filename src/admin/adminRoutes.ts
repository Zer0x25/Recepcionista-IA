import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getConversationSnapshotById,
  getConversationSnapshotByContact,
} from "./conversationRead.js";
import { logger } from "../observability/logger.js";

const AdminParamsSchema = z.object({
  id: z.string().uuid(),
});

const AdminByContactParamsSchema = z.object({
  providerContact: z.string(),
});

const AdminQuerySchema = z.object({
  limitMessages: z
    .preprocess((val) => Number(val), z.number().int().min(1).max(200))
    .optional()
    .default(50),
});

export async function adminRoutes(fastify: FastifyInstance) {
  // Middleware to check ADMIN_API_KEY
  fastify.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      const providedKey = request.headers["x-admin-key"];

      if (!adminKey || providedKey !== adminKey) {
        logger.warn({
          msg: "Unauthorized admin access attempt",
          eventType: "ADMIN_READ_UNAUTHORIZED",
          requestId: request.requestId,
        });
        return reply.code(401).send({ error: "Unauthorized" });
      }
    },
  );

  // GET /admin/conversations/:id
  fastify.get("/admin/conversations/:id", async (request, reply) => {
    const paramsResult = AdminParamsSchema.safeParse(request.params);
    const queryResult = AdminQuerySchema.safeParse(request.query);

    if (!paramsResult.success) {
      return reply.code(400).send({
        error: "Invalid parameters",
        details: paramsResult.error.format(),
      });
    }

    if (!queryResult.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: queryResult.error.format(),
      });
    }

    const { id } = paramsResult.data;
    const { limitMessages } = queryResult.data;

    const snapshot = await getConversationSnapshotById(id, limitMessages);

    if (!snapshot) {
      return reply.code(404).send({ error: "Conversation not found" });
    }

    logger.info({
      msg: "Admin read conversation by ID",
      eventType: "ADMIN_READ_CONVERSATION_ID",
      requestId: request.requestId,
      conversationId: id,
    });

    return snapshot;
  });

  // GET /admin/conversations/by-contact/:providerContact
  fastify.get(
    "/admin/conversations/by-contact/:providerContact",
    async (request, reply) => {
      const paramsResult = AdminByContactParamsSchema.safeParse(request.params);
      const queryResult = AdminQuerySchema.safeParse(request.query);

      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "Invalid parameters",
          details: paramsResult.error.format(),
        });
      }

      if (!queryResult.success) {
        return reply.code(400).send({
          error: "Invalid query parameters",
          details: queryResult.error.format(),
        });
      }

      const { providerContact } = paramsResult.data;
      const { limitMessages } = queryResult.data;

      const snapshot = await getConversationSnapshotByContact(
        providerContact,
        limitMessages,
      );

      if (!snapshot) {
        return reply.code(404).send({ error: "Conversation not found" });
      }

      logger.info({
        msg: "Admin read conversation by contact",
        eventType: "ADMIN_READ_CONVERSATION_CONTACT",
        requestId: request.requestId,
        conversationId: snapshot.id,
      });

      return snapshot;
    },
  );
}
