import { env } from "../config/env.js";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getConversationSnapshotById,
  getConversationSnapshotByContact,
} from "./conversationRead.js";
import { logger } from "../observability/logger.js";
import { MetricsService } from "../metrics/metrics.service.js";
import { prisma } from "../persistence/prisma.js";

const AdminParamsSchema = z.object({
  id: z.string().uuid(),
});

const AdminByContactParamsSchema = z.object({
  providerContact: z.string(),
});

const AdminQuerySchema = z.object({
  limitMessages: z.coerce.number().int().min(1).max(200).default(50),
});

export async function adminRoutes(fastify: FastifyInstance) {
  // Middleware to check ADMIN_API_KEY
  fastify.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminKey = env.ADMIN_API_KEY;
      const providedKey = request.headers["x-admin-key"];

      const log = logger.child({
        requestId: request.requestId,
        scope: "admin",
        route: (request as any).routerPath ?? request.url,
      });

      // Attach logger to request for handlers to reuse
      (request as any).adminLog = log;

      if (!adminKey || providedKey !== adminKey) {
        log.warn({
          msg: "Unauthorized admin access attempt",
          eventType: "ADMIN_READ_UNAUTHORIZED",
        });
        return reply.code(401).send({ error: "Unauthorized" });
      }
    },
  );

  // GET /admin/metrics/summary
  fastify.get("/admin/metrics/summary", async (request, reply) => {
    const start = Date.now();
    const log = (request as any).adminLog;

    const [backlogSize, collisionRate, ttlExpiryRate, sendSuccessRate] =
      await Promise.all([
        MetricsService.getBacklogSize(),
        MetricsService.getRecentCollisionRate(),
        MetricsService.getRecentTTlExpiryRate(),
        MetricsService.getSendSuccessRate(),
      ]);

    const durationMs = Date.now() - start;
    log.info({
      eventType: "ADMIN_METRICS_SUMMARY_SUCCESS",
      durationMs,
    });

    return {
      backlogSize,
      collisionRate,
      ttlExpiryRate,
      sendSuccessRate,
    };
  });

  // GET /admin/jobs/backlog
  fastify.get("/admin/jobs/backlog", async (request, reply) => {
    const start = Date.now();
    const log = (request as any).adminLog;

    const countsByStatus = await MetricsService.getJobsByStatus();

    const durationMs = Date.now() - start;
    log.info({
      eventType: "ADMIN_JOBS_BACKLOG_SUCCESS",
      durationMs,
    });

    return countsByStatus;
  });

  // GET /admin/worker/heartbeat
  fastify.get("/admin/worker/heartbeat", async (request, reply) => {
    const start = Date.now();
    const log = (request as any).adminLog;

    const heartbeats = await prisma.workerHeartbeat.findMany({
      orderBy: { lastSeenAt: "desc" },
      take: 50,
    });

    const durationMs = Date.now() - start;
    log.info({
      eventType: "ADMIN_WORKER_HEARTBEAT_SUCCESS",
      durationMs,
    });

    return heartbeats;
  });

  // GET /admin/conversations/:id
  fastify.get("/admin/conversations/:id", async (request, reply) => {
    const start = Date.now();
    const log = (request as any).adminLog;

    const paramsResult = AdminParamsSchema.safeParse(request.params);
    const queryResult = AdminQuerySchema.safeParse(request.query);

    if (!paramsResult.success) {
      log.warn({
        eventType: "ADMIN_READ_INVALID_PARAMS",
        durationMs: Date.now() - start,
      });
      return reply.code(400).send({
        error: "Invalid parameters",
        details: paramsResult.error.format(),
      });
    }

    if (!queryResult.success) {
      log.warn({
        eventType: "ADMIN_READ_INVALID_QUERY",
        durationMs: Date.now() - start,
        limitMessages: "raw/unknown",
      });
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: queryResult.error.format(),
      });
    }

    const { id } = paramsResult.data;
    const { limitMessages } = queryResult.data;

    const snapshot = await getConversationSnapshotById(id, limitMessages);

    if (!snapshot) {
      log.warn({
        eventType: "ADMIN_READ_NOT_FOUND",
        durationMs: Date.now() - start,
        conversationId: id,
      });
      return reply.code(404).send({ error: "Conversation not found" });
    }

    log.info({
      msg: "Admin read conversation by ID",
      eventType: "ADMIN_READ_SUCCESS",
      durationMs: Date.now() - start,
      conversationId: id,
      limitMessages,
    });

    return snapshot;
  });

  // GET /admin/conversations/by-contact/:providerContact
  fastify.get(
    "/admin/conversations/by-contact/:providerContact",
    async (request, reply) => {
      const start = Date.now();
      const log = (request as any).adminLog;

      const paramsResult = AdminByContactParamsSchema.safeParse(request.params);
      const queryResult = AdminQuerySchema.safeParse(request.query);

      if (!paramsResult.success) {
        log.warn({
          eventType: "ADMIN_READ_INVALID_PARAMS",
          durationMs: Date.now() - start,
        });
        return reply.code(400).send({
          error: "Invalid parameters",
          details: paramsResult.error.format(),
        });
      }

      if (!queryResult.success) {
        log.warn({
          eventType: "ADMIN_READ_INVALID_QUERY",
          durationMs: Date.now() - start,
          limitMessages: "raw/unknown",
        });
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
        log.warn({
          eventType: "ADMIN_READ_NOT_FOUND",
          durationMs: Date.now() - start,
          providerContact,
        });
        return reply.code(404).send({ error: "Conversation not found" });
      }

      log.info({
        msg: "Admin read conversation by contact",
        eventType: "ADMIN_READ_SUCCESS",
        durationMs: Date.now() - start,
        conversationId: snapshot.id,
        providerContact,
        limitMessages,
      });

      return snapshot;
    },
  );
}
