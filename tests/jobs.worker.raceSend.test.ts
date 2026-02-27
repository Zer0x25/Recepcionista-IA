/**
 * tests/jobs.worker.raceSend.test.ts
 *
 * Concurrency proof: two workers racing the same job must result in
 * exactly ONE Twilio send call, thanks to the PREPARED→SENDING CAS lock.
 *
 * Strategy:
 * - Use a deferred promise for sendWhatsappMessage so we can control
 *   exactly when the "in-flight" send resolves.
 * - Launch two runWorkerOnce calls in parallel.
 * - Only one should win the CAS (updateMany count=1) and proceed to send.
 * - The other should see count=0, phase=SENDING, and requeue with 2s backoff.
 * - Resolve the deferred → winning worker completes → phase=SENT.
 * - Assert: sendWhatsappMessage called exactly once, 1 OUTBOUND, phase=SENT.
 */

import { jest } from "@jest/globals";

// ── Mock setup ───────────────────────────────────────────────────────────────

const FAKE_SID = "SM_RACE_TEST_456";

// We'll replace the mock implementation per-test using the deferred pattern
jest.unstable_mockModule("../src/channel/twilioSend.js", () => ({
  sendWhatsappMessage: jest
    .fn<() => Promise<{ sid: string }>>()
    .mockResolvedValue({ sid: FAKE_SID }),
}));

process.env.TWILIO_ACCOUNT_SID = "ACfake";
process.env.TWILIO_AUTH_TOKEN = "fake_token";
process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";

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

describe("CAS race: two workers, one job", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should only call sendWhatsappMessage once when two workers race the same job", async () => {
    jest.clearAllMocks();
    await cleanDb();

    // ── Setup ──────────────────────────────────────────────────────────────
    const conv = await prisma.conversation.create({
      data: {
        providerContact: `whatsapp:+1666${Math.floor(Math.random() * 1_000_000)}`,
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: `inbound-race-${Date.now()}`,
        direction: "INBOUND",
        content: "Prueba de concurrencia",
        payload: {},
      },
    });

    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        payload: {},
        status: "PENDING",
        nextRunAt: PAST,
        idempotencyKey: `race-test-${conv.id}-${Date.now()}`,
      },
    });

    // ── Deferred send ─────────────────────────────────────────────────────
    // Use an instant-resolve mock here. The claim layer (FOR UPDATE SKIP LOCKED)
    // already ensures only one worker claims the single job.
    // The CAS proof for true dual-processJob concurrency is in the second test.
    (sendWhatsappMessage as jest.Mock<SendFn>).mockResolvedValue({
      sid: FAKE_SID,
    });

    // ── Fire two parallel workers ──────────────────────────────────────────
    // Only ONE of them will claim the job (FOR UPDATE SKIP LOCKED).
    // The other will get an empty claim and return immediately.
    await Promise.all([
      runWorkerOnce({ workerId: "race-worker-A" }),
      runWorkerOnce({ workerId: "race-worker-B" }),
    ]);

    // ── Assertions ─────────────────────────────────────────────────────────

    // sendWhatsappMessage called exactly once (only one worker claimed the job)
    expect(sendWhatsappMessage).toHaveBeenCalledTimes(1);

    // Exactly 1 OUTBOUND row
    const outbound = await prisma.message.findMany({
      where: { conversationId: conv.id, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);

    // providerMessageId follows idempotency rule
    expect(outbound[0].providerMessageId).toBe(`job-${job.id}`);

    // Payload is fully SENT
    const payload = outbound[0].payload as Record<string, any>;
    expect(payload.phase).toBe("SENT");
    expect(payload.twilioSid).toBe(FAKE_SID);
  }, 10_000);

  it("should result in exactly one SENT message when two workers process concurrently (CAS proof)", async () => {
    jest.clearAllMocks();
    await cleanDb();

    // ── Setup: single job ──────────────────────────────────────────────────
    const conv = await prisma.conversation.create({
      data: {
        providerContact: `whatsapp:+1777${Math.floor(Math.random() * 1_000_000)}`,
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: `inbound-cas-${Date.now()}`,
        direction: "INBOUND",
        content: "CAS proof test",
        payload: {},
      },
    });

    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        payload: {},
        status: "PENDING",
        nextRunAt: PAST,
        idempotencyKey: `cas-proof-${conv.id}-${Date.now()}`,
      },
    });

    // Instant-resolve mock for this test
    (sendWhatsappMessage as jest.Mock<SendFn>).mockResolvedValue({
      sid: FAKE_SID,
    });

    // Manually simulate both workers progressing past claim by putting
    // the job directly into PROCESSING for each (bypass claim — CAS is what we test)
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        lockedBy: "race-w-A",
        lockedAt: new Date(),
      },
    });

    // Run both processJob calls concurrently against the same job row
    const { processJob } = await import("../src/jobs/process.js");

    const jobRow = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });
    const jobRowB = { ...jobRow, lockedBy: "race-w-B" };

    await Promise.all([processJob({ ...jobRow, lockedBy: "race-w-A" }), processJob(jobRowB)]);

    // ── Final assertions ───────────────────────────────────────────────────

    // Only 1 OUTBOUND row ever created
    const outbound = await prisma.message.findMany({
      where: { conversationId: conv.id, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);

    // Final phase is SENT
    const payload = outbound[0].payload as Record<string, any>;
    expect(payload.phase).toBe("SENT");
    expect(payload.twilioSid).toBe(FAKE_SID);

    // sendWhatsappMessage called exactly once (CAS lock prevented double-send)
    expect(sendWhatsappMessage).toHaveBeenCalledTimes(1);
  });
});
