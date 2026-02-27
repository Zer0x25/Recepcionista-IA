/**
 * tests/jobs.worker.sendingTtl.test.ts
 *
 * Verification of the TTL "unstick" mechanism.
 * If a message is stuck in SENDING for too long, it should be reverted to PREPARED.
 */

import { jest } from "@jest/globals";
import { SENDING_TTL_MS } from "../src/jobs/constants.js";

// ── Mock setup ──────────────────────────────────────────────────────────────
jest.unstable_mockModule("../src/channel/twilioSend.js", () => ({
  sendWhatsappMessage: jest
    .fn<() => Promise<any>>()
    .mockRejectedValue(new Error("Should not be called")),
}));

const { prisma } = await import("../src/persistence/prisma.js");
const { processJob } = await import("../src/jobs/process.js");
const { sendWhatsappMessage } =
  (await import("../src/channel/twilioSend.js")) as {
    sendWhatsappMessage: jest.Mock<any>;
  };

async function cleanDb() {
  await prisma.job.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

describe("SENDING TTL expiry", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanDb();
  });

  it("should unstick a message if sendingLockedAt is expired", async () => {
    // 1. Setup Conversation
    const conv = await prisma.conversation.create({
      data: { providerContact: "whatsapp:+123456789" },
    });

    // 2. Setup Inbound Message (required by processJob)
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: "inbound-1",
        direction: "INBOUND",
        content: "Hello",
        payload: {},
      },
    });

    // 3. Setup Job
    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: "PROCESSING",
        lockedBy: "worker-1",
        lockedAt: new Date(),
        payload: {},
        idempotencyKey: `ttl-test-${Date.now()}`,
      },
    });

    // 4. Setup Stuck Outbound Message
    const expiredDate = new Date(
      Date.now() - (SENDING_TTL_MS + 5_000),
    ).toISOString();
    const outboundProviderMessageId = `job-${job.id}`;
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: outboundProviderMessageId,
        direction: "OUTBOUND",
        content: "Reply",
        payload: {
          phase: "SENDING",
          sendingLockedAt: expiredDate,
          sendingLockedBy: "dead-worker",
        },
      },
    });

    // 5. Run processJob
    await processJob(job);

    // 6. Assertions
    const message = await prisma.message.findUniqueOrThrow({
      where: { providerMessageId: outboundProviderMessageId },
    });
    const payload = message.payload as any;

    expect(payload.phase).toBe("PREPARED");
    expect(payload.lastSendError).toBe("SENDING_TTL_EXPIRED");
    expect(payload.ttlExpiredAt).toBeDefined();
    expect(payload.previousSendingLockedAt).toBe(expiredDate);
    expect(payload.sendingLockedAt).toBeUndefined();

    const updatedJob = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(updatedJob.status).toBe("PENDING");
    expect(updatedJob.nextRunAt.getTime()).toBeGreaterThanOrEqual(Date.now());

    expect(sendWhatsappMessage).not.toHaveBeenCalled();
  });

  it("should NOT unstick a message if sendingLockedAt is fresh", async () => {
    // 1. Setup Conversation
    const conv = await prisma.conversation.create({
      data: { providerContact: "whatsapp:+123456789" },
    });

    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: "inbound-2",
        direction: "INBOUND",
        content: "Hello again",
        payload: {},
      },
    });

    // 2. Setup Job
    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: "PROCESSING",
        lockedBy: "worker-2",
        lockedAt: new Date(),
        payload: {},
        idempotencyKey: `fresh-test-${Date.now()}`,
      },
    });

    // 3. Setup Fresh Outbound Message
    const freshDate = new Date(Date.now() - 5_000).toISOString();
    const outboundProviderMessageId = `job-${job.id}`;
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: outboundProviderMessageId,
        direction: "OUTBOUND",
        content: "Reply",
        payload: {
          phase: "SENDING",
          sendingLockedAt: freshDate,
          sendingLockedBy: "active-worker",
        },
      },
    });

    // 4. Run processJob
    await processJob(job);

    // 5. Assertions
    const message = await prisma.message.findUniqueOrThrow({
      where: { providerMessageId: outboundProviderMessageId },
    });
    const payload = message.payload as any;

    expect(payload.phase).toBe("SENDING");
    expect(payload.sendingLockedAt).toBe(freshDate);

    const updatedJob = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(updatedJob.status).toBe("PENDING");
    // Should be approx 2s backoff
    expect(updatedJob.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    expect(sendWhatsappMessage).not.toHaveBeenCalled();
  });
});
