import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

export async function setupTestEnv() {
  process.env.ALLOW_INSECURE_WEBHOOK = "true";
  process.env.NODE_ENV = "test";
  await fastify.ready();
  await prisma.stateTransition.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

export async function teardownTestEnv() {
  await fastify.close();
  await prisma.$disconnect();
  process.env.ALLOW_INSECURE_WEBHOOK = "false";
  process.env.NODE_ENV = "test";
}

export function makeTestLogger() {
  const allCalls: any[] = [];

  const createFakeLogger = (context: any = {}) => {
    const loggerInstance: any = {
      info: (obj: any) => {
        const payload = typeof obj === "string" ? { msg: obj } : obj;
        allCalls.push({ ...context, ...payload, level: "info" });
      },
      warn: (obj: any) => {
        const payload = typeof obj === "string" ? { msg: obj } : obj;
        allCalls.push({ ...context, ...payload, level: "warn" });
      },
      error: (obj: any) => {
        const payload = typeof obj === "string" ? { msg: obj } : obj;
        allCalls.push({ ...context, ...payload, level: "error" });
      },
      debug: (obj: any) => {
        const payload = typeof obj === "string" ? { msg: obj } : obj;
        allCalls.push({ ...context, ...payload, level: "debug" });
      },
      child: (newContext: any) => {
        return createFakeLogger({ ...context, ...newContext });
      },
    };
    return loggerInstance;
  };

  return {
    loggerFake: createFakeLogger(),
    getLogs: () => allCalls,
  };
}
