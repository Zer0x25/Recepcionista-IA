/**
 * tests/jobs.worker.test.ts
 *
 * End-to-end test for runWorkerOnce():
 * - Verifies job transitions PENDING → DONE
 * - Verifies exactly 1 OUTBOUND message created with idempotent providerMessageId
 * - Verifies second run creates no additional OUTBOUND message (idempotency)
 */
import { prisma } from "../src/persistence/prisma.js";
import { runWorkerOnce } from "../src/worker.js";

const PAST = new Date(Date.now() - 60_000);

async function cleanDb() {
  await prisma.job.deleteMany();
  await prisma.stateTransition.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

describe("runWorkerOnce — end-to-end", () => {
  let conversationId: string;
  let jobId: string;

  beforeEach(async () => {
    await cleanDb();

    // Create conversation
    const conv = await prisma.conversation.create({
      data: {
        providerContact: `+1555${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    conversationId = conv.id;

    // Create inbound message
    await prisma.message.create({
      data: {
        conversationId,
        providerMessageId: `inbound-${Date.now()}`,
        direction: "INBOUND",
        content: "Hello, I need help with my order",
        payload: {},
      },
    });

    // Create pending job
    const job = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId,
        payload: {},
        status: "PENDING",
        nextRunAt: PAST,
        idempotencyKey: `worker-test-${conversationId}-${Date.now()}`,
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should process the job and create exactly 1 OUTBOUND message", async () => {
    await runWorkerOnce({ workerId: "test-worker" });

    // Job is DONE
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("DONE");
    expect(job.lockedBy).toBeNull();
    expect(job.lockedAt).toBeNull();

    // Exactly 1 OUTBOUND message
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);

    // providerMessageId follows idempotency rule: "job-${jobId}"
    expect(outbound[0].providerMessageId).toBe(`job-${jobId}`);
  });

  it("should NOT create a second OUTBOUND message when run again (idempotency)", async () => {
    // First run
    await runWorkerOnce({ workerId: "test-worker" });

    // Manually reset job to PENDING so the second run can claim it again
    // (simulates a crash scenario where job was not marked DONE but message exists)
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        nextRunAt: PAST,
        lockedAt: null,
        lockedBy: null,
      },
    });

    // Second run
    await runWorkerOnce({ workerId: "test-worker-2" });

    // Still only 1 OUTBOUND message
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(1);
  });

  it("should leave no OUTBOUND message if conversation has no inbound messages", async () => {
    // Create a fresh conversation with no messages
    const conv2 = await prisma.conversation.create({
      data: {
        providerContact: `+1777${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    const job2 = await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv2.id,
        payload: {},
        status: "PENDING",
        nextRunAt: PAST,
        maxAttempts: 1, // fail immediately
        idempotencyKey: `no-msg-test-${conv2.id}-${Date.now()}`,
      },
    });

    await runWorkerOnce({ workerId: "test-worker" });

    // Job should be FAILED (no inbound message found)
    const failedJob = await prisma.job.findUniqueOrThrow({
      where: { id: job2.id },
    });
    expect(failedJob.status).toBe("FAILED");
    expect(failedJob.lastError).toContain("No inbound message");

    // No OUTBOUND message
    const outbound = await prisma.message.findMany({
      where: { conversationId: conv2.id, direction: "OUTBOUND" },
    });
    expect(outbound.length).toBe(0);
  });
});
