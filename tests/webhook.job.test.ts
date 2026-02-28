/**
 * tests/webhook.job.test.ts
 *
 * Integration test for Sprint 2 / Step 3:
 * - Webhook creates a Job (AI_REPLY_REQUESTED) atomically with inbound message
 * - Duplicate providerMessageId → idempotent: no duplicate message or job
 * - Webhook never creates OUTBOUND messages
 */
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

async function cleanDb() {
  await prisma.job.deleteMany();
  await prisma.stateTransition.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

const BASE_PAYLOAD = {
  MessageSid: `SM_JOB_TEST_${Date.now()}`,
  Body: "Hola, necesito ayuda",
  From: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
  To: "+10000000001",
  AccountSid: "AC_JOB_TEST",
};

describe("Webhook → Job creation (ADR-006)", () => {
  beforeAll(async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "development";
    await fastify.ready();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.NODE_ENV = "test";
  });

  it("should create exactly 1 inbound message and 1 Job, 0 outbound messages", async () => {
    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(BASE_PAYLOAD).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    // 1. HTTP 200 fast response
    expect(response.status).toBe(200);
    expect(response.text).toBe("<Response></Response>");

    // 2. Inbound message created exactly once
    const messages = await prisma.message.findMany({
      where: { providerMessageId: BASE_PAYLOAD.MessageSid },
    });
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("INBOUND");

    const conversationId = messages[0].conversationId;

    // 3. Job created exactly once with correct fields
    const jobs = await prisma.job.findMany({
      where: {
        idempotencyKey: `ai-reply:${conversationId}:${BASE_PAYLOAD.MessageSid}`,
      },
    });
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe("AI_REPLY_REQUESTED");
    expect(jobs[0].status).toBe("PENDING");
    expect(jobs[0].conversationId).toBe(conversationId);
    expect(jobs[0].idempotencyKey).toBe(`ai-reply:${conversationId}:${BASE_PAYLOAD.MessageSid}`);

    // 4. No OUTBOUND message created by webhook
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(0);
  });

  it("should be idempotent: duplicate providerMessageId creates no new records", async () => {
    // First request
    const res1 = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(BASE_PAYLOAD).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(res1.status).toBe(200);

    // Capture state after first request
    const inboundAfterFirst = await prisma.message.findMany({
      where: { providerMessageId: BASE_PAYLOAD.MessageSid },
    });
    expect(inboundAfterFirst.length).toBe(1);
    const conversationId = inboundAfterFirst[0].conversationId;

    const jobsAfterFirst = await prisma.job.findMany({
      where: {
        idempotencyKey: `ai-reply:${conversationId}:${BASE_PAYLOAD.MessageSid}`,
      },
    });
    expect(jobsAfterFirst.length).toBe(1);

    // Second request — same providerMessageId
    const res2 = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(BASE_PAYLOAD).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(res2.status).toBe(200);
    expect(res2.text).toBe("<Response></Response>");

    // Inbound message count unchanged
    const inboundAfterSecond = await prisma.message.findMany({
      where: { providerMessageId: BASE_PAYLOAD.MessageSid },
    });
    expect(inboundAfterSecond.length).toBe(1);

    // Job count unchanged
    const jobsAfterSecond = await prisma.job.findMany({
      where: {
        idempotencyKey: `ai-reply:${conversationId}:${BASE_PAYLOAD.MessageSid}`,
      },
    });
    expect(jobsAfterSecond.length).toBe(1);

    // Still no OUTBOUND messages
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(0);
  });
});
