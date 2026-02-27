import { env } from "./config/env.js";
import Fastify from "fastify";
import formBody from "@fastify/formbody";
import { logger } from "./observability/logger.js";
import { twilioWebhookHandler } from "./channel/twilioWebhook.js";
import { adminRoutes } from "./admin/adminRoutes.js";
import { healthExtendedRoutes } from "./admin/health.extended.js";
import { prisma } from "./persistence/prisma.js";

import { randomUUID } from "node:crypto";

const fastify = Fastify({
  logger: false, // We use our own Pino logger
});

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

fastify.addHook("onRequest", async (request, reply) => {
  request.requestId = randomUUID();
});

import rateLimit from "@fastify/rate-limit";

// Register plugins
await fastify.register(formBody);
await fastify.register(rateLimit, {
  max: env.NODE_ENV === "test" ? 20 : 100,
  timeWindow: "1 minute",
  hook: "preValidation",
  keyGenerator: (request) => {
    // If request has 'From' in body (Twilio webhook), use it
    const from = (request.body as any)?.From;
    return from || request.ip;
  },
  onExceeding: (request, key) => {
    logger.warn({
      msg: "Rate limit exceeded",
      eventType: "WEBHOOK_RATE_LIMITED",
      requestId: (request as any).requestId,
      key,
      ip: request.ip,
    });
  },
});

// Register routes
await fastify.register(twilioWebhookHandler);
await fastify.register(adminRoutes);
await fastify.register(healthExtendedRoutes);

const start = async () => {
  try {
    const { PORT: port } = env;
    const host = "0.0.0.0";
    await fastify.listen({ port, host });
    logger.info({
      msg: "Server started",
      eventType: "SERVER_START",
      port,
      host,
    });
  } catch (err) {
    logger.error({
      msg: "Server failed to start",
      eventType: "SERVER_ERROR",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info({
    msg: "Shutting down server",
    eventType: "SERVER_SHUTDOWN",
  });
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (env.NODE_ENV !== "test") {
  start();
}

export { fastify };
