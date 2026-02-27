/**
 * tests/jobs.claim.test.ts
 *
 * Verifies that claimNextJobs() is concurrency-safe:
 * two workers claiming simultaneously get disjoint sets of jobs.
 */
import { prisma } from "../src/persistence/prisma.js";
import { claimNextJobs } from "../src/jobs/claim.js";

const PAST = new Date(Date.now() - 60_000); // 1 minute ago

async function cleanDb() {
  await prisma.job.deleteMany();
  await prisma.stateTransition.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
}

async function createConversation() {
  return prisma.conversation.create({
    data: { providerContact: `+1555${Math.floor(Math.random() * 1_000_000)}` },
  });
}

async function createPendingJob(conversationId: string, i: number) {
  return prisma.job.create({
    data: {
      type: "AI_REPLY_REQUESTED",
      conversationId,
      payload: { seq: i },
      status: "PENDING",
      nextRunAt: PAST,
      idempotencyKey: `claim-test-${conversationId}-${i}-${Date.now()}`,
    },
  });
}

describe("claimNextJobs — concurrency safety", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should claim all N jobs with no duplicates across two concurrent workers", async () => {
    const conversation = await createConversation();
    const N = 3;

    for (let i = 0; i < N; i++) {
      await createPendingJob(conversation.id, i);
    }

    // Two workers race simultaneously
    const [claimedA, claimedB] = await Promise.all([
      claimNextJobs("worker-A", 10),
      claimNextJobs("worker-B", 10),
    ]);

    const idsA = claimedA.map((j: any) => j.id);
    const idsB = claimedB.map((j: any) => j.id);
    const allIds = [...idsA, ...idsB];

    // Total claimed equals N
    expect(allIds.length).toBe(N);

    // No duplicates across both workers
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(N);

    // Each claimed job shows PROCESSING and the correct lockedBy
    for (const job of claimedA) {
      expect(job.status).toBe("PROCESSING");
      expect(job.lockedBy).toBe("worker-A");
    }
    for (const job of claimedB) {
      expect(job.status).toBe("PROCESSING");
      expect(job.lockedBy).toBe("worker-B");
    }
  });

  it("should not claim jobs with nextRunAt in the future", async () => {
    const conversation = await createConversation();
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conversation.id,
        payload: {},
        status: "PENDING",
        nextRunAt: new Date(Date.now() + 60_000), // future
        idempotencyKey: `future-job-${Date.now()}`,
      },
    });

    const claimed = await claimNextJobs("worker-A", 10);
    expect(claimed.length).toBe(0);
  });

  it("should not claim jobs that are already PROCESSING (not expired)", async () => {
    const conversation = await createConversation();
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conversation.id,
        payload: {},
        status: "PROCESSING",
        nextRunAt: PAST,
        lockedAt: new Date(), // locked just now — not expired
        lockedBy: "another-worker",
        idempotencyKey: `locked-job-${Date.now()}`,
      },
    });

    const claimed = await claimNextJobs("worker-A", 10);
    expect(claimed.length).toBe(0);
  });
});
