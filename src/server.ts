import Fastify from "fastify";
import formBody from "@fastify/formbody";
import { logger } from "./observability/logger.js";
import { twilioWebhookHandler } from "./channel/twilioWebhook.js";
import { prisma } from "./persistence/prisma.js";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({
  logger: false, // We use our own Pino logger
});

// Register plugins
await fastify.register(formBody);

// Register routes
await fastify.register(twilioWebhookHandler);

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: "0.0.0.0" });
    logger.info(`Server listening on http://localhost:${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down server...");
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (process.env.NODE_ENV !== "test") {
  start();
}

export { fastify };
