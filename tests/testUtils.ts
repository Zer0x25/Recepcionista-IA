import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

export async function setupTestEnv() {
  process.env.ALLOW_INSECURE_WEBHOOK = "true";
  process.env.NODE_ENV = "test";
  await fastify.ready();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

export async function teardownTestEnv() {
  await fastify.close();
  await prisma.$disconnect();
  process.env.ALLOW_INSECURE_WEBHOOK = "false";
  process.env.NODE_ENV = "test";
}
