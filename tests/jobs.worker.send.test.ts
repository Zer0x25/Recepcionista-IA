/**
 * tests/jobs.worker.send.test.ts
 *
 * End-to-end integration test for the Twilio-enabled worker flow.
 *
 * Strategy:
 * - Mock sendWhatsappMessage so no real Twilio calls happen.
 * - Use real DB (test Postgres) for full idempotency verification.
 * - Verify OUTBOUND phases: PREPARED→SENDING→SENT with correct payload fields.
 * - Verify second run does NOT call sendWhatsappMessage again.
 */

import { jest } from "@jest/globals";

const FAKE_SID = "SM_FAKE_123";

// Mock twilioSend BEFORE importing anything that depends on it
jest.unstable_mockModule("../src/channel/twilioSend.js", () => ({
  sendWhatsappMessage: jest
    .fn<() => Promise<{ sid: string }>>()
    .mockResolvedValue({ sid: FAKE_SID }),
}));

// Set required env vars before any module import
process.env.TWILIO_ACCOUNT_SID = "ACfake";
process.env.TWILIO_AUTH_TOKEN = "fake_token";
process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";

// Dynamic imports AFTER mocks are set
const { prisma } = await import("../src/persistence/prisma.js");
const { runWorkerOnce } = await import("../src/worker.js");
type SendFn = () => Promise<{ sid: string }>;
const { sendWhatsappMessage } = (await import("../src/channel/twilioSend.js")) as {
  sendWhatsappMessage: jest.Mock<SendFn>;
};

const PAST = new Date(Date.now() - 60_000);

async function cleanDb() {
  await prisma.job.deleteMany();
  await prisma.stateTransition.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

describe("runWorkerOnce — Twilio outbound send", () => {
  let conversationId: string;
  let jobId: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanDb();

    // Conversation with a WhatsApp number
    const conv = await prisma.conversation.create({
      data: {
        providerContact: `whatsapp:+1555${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    conversationId = conv.id;

    // Inbound message (gives worker something to "reply" to)
    await prisma.message.create({
      data: {
        conversationId,
        providerMessageId: `inbound-send-${Date.now()}`,
        direction: "INBOUND",
        content: "Hola, necesito ayuda",
        payload: {},
      },
    });

    // Pending AI_REPLY_REQUESTED job
    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId,
        payload: {},
        status: "PENDING",
        nextRunAt: PAST,
        idempotencyKey: `send-test-${conversationId}-${Date.now()}`,
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should send via Twilio, create OUTBOUND with phase=SENT and twilioSid", async () => {
    await runWorkerOnce({ workerId: "test-worker-send" });

    // 1. Job is DONE
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("DONE");
    expect(job.lockedBy).toBeNull();
    expect(job.lockedAt).toBeNull();

    // 2. Exactly 1 OUTBOUND message
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);

    // 3. providerMessageId is idempotency key
    expect(outbound[0].providerMessageId).toBe(`job-${jobId}`);

    // 4. payload reflects SENT state
    const payload = outbound[0].payload as Record<string, any>;
    expect(payload.phase).toBe("SENT");
    expect(payload.twilioSid).toBe(FAKE_SID);
    expect(typeof payload.sentAt).toBe("string");

    // 5. SENDING lock fields cleared (not present after SENT)
    expect(payload.sendingLockedAt).toBeUndefined();
    expect(payload.sendingLockedBy).toBeUndefined();

    // 6. sendWhatsappMessage was called once
    expect(sendWhatsappMessage).toHaveBeenCalledTimes(1);
  });

  it("should NOT call sendWhatsappMessage again on retry if already SENT (idempotency)", async () => {
    // First run — normal happy path
    await runWorkerOnce({ workerId: "test-worker-send-1" });

    expect(sendWhatsappMessage).toHaveBeenCalledTimes(1);

    // Simulate crash: reset job to PENDING without touching the OUTBOUND message
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        nextRunAt: PAST,
        lockedAt: null,
        lockedBy: null,
      },
    });

    jest.clearAllMocks();

    // Second run — should detect phase=SENT and skip Twilio
    await runWorkerOnce({ workerId: "test-worker-send-2" });

    // sendWhatsappMessage NOT called again
    expect(sendWhatsappMessage).not.toHaveBeenCalled();

    // Still exactly 1 OUTBOUND message
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);

    // Job still ends as DONE
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("DONE");
  });

  it("should revert OUTBOUND to PREPARED and requeue job when Twilio send fails", async () => {
    // Make the first (and only) Twilio call fail
    (sendWhatsappMessage as jest.Mock<SendFn>).mockRejectedValueOnce(
      new Error("Twilio network error"),
    );

    await runWorkerOnce({ workerId: "test-worker-send-fail" });

    // Job should be back in PENDING (retry scheduled)
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("PENDING");
    expect(job.lastError).toContain("Twilio network error");

    // OUTBOUND should have reverted to PREPARED (not stuck in SENDING)
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);
    const payload = outbound[0].payload as Record<string, any>;
    expect(payload.phase).toBe("PREPARED");
    expect(payload.lastSendError).toContain("Twilio network error");
  });
});
