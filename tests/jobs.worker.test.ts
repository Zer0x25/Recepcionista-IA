import { jest } from "@jest/globals";

// Mock Twilio send before any other import
jest.unstable_mockModule("../src/channel/twilioSend.js", () => ({
  sendWhatsappMessage: jest
    .fn<() => Promise<{ sid: string }>>()
    .mockResolvedValue({ sid: "SM_WORKER_TEST_STUB" }),
}));

// Mock logger to allow capturing
jest.unstable_mockModule("../src/observability/logger.js", () => {
  const allCalls: any[] = [];
  const createFakeLogger = (context: any = {}) => ({
    info: (obj: any) =>
      allCalls.push({
        ...context,
        ...(typeof obj === "string" ? { msg: obj } : obj),
        level: "info",
      }),
    warn: (obj: any) =>
      allCalls.push({
        ...context,
        ...(typeof obj === "string" ? { msg: obj } : obj),
        level: "warn",
      }),
    error: (obj: any) =>
      allCalls.push({
        ...context,
        ...(typeof obj === "string" ? { msg: obj } : obj),
        level: "error",
      }),
    debug: (obj: any) =>
      allCalls.push({
        ...context,
        ...(typeof obj === "string" ? { msg: obj } : obj),
        level: "debug",
      }),
    child: (newContext: any) => createFakeLogger({ ...context, ...newContext }),
  });
  const loggerFake = createFakeLogger();
  return {
    logger: loggerFake,
    default: loggerFake,
    getTestLogs: () => allCalls,
    clearTestLogs: () => {
      allCalls.length = 0;
    },
  };
});

// Set env vars before modules load
process.env.TWILIO_ACCOUNT_SID = "ACfake";
process.env.TWILIO_AUTH_TOKEN = "fake_token";
process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";

const { prisma } = await import("../src/persistence/prisma.js");
const { runWorkerOnce } = await import("../src/worker.js");
const { sendWhatsappMessage } = await import("../src/channel/twilioSend.js");
const { getTestLogs, clearTestLogs } = (await import("../src/observability/logger.js")) as any;

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

  it("should log JOB_PROCESS_FAILED_FINAL with all structured fields on max attempts", async () => {
    // 0. Clean DB and logs to avoid interference from beforeEach job or other tests
    await cleanDb();
    clearTestLogs();

    // 1. Mock Twilio to fail
    (
      sendWhatsappMessage as unknown as jest.MockedFunction<typeof sendWhatsappMessage>
    ).mockRejectedValueOnce(new Error("Twilio down"));

    // 2. Create a job that will fail on its first attempt (maxAttempts=1)
    const conv = await prisma.conversation.create({
      data: { providerContact: "+541100000000" },
    });
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        providerMessageId: `inbound-${Date.now()}`,
        direction: "INBOUND",
        content: "Fail me",
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
        maxAttempts: 1,
        idempotencyKey: `fail-test-${conv.id}-${Date.now()}`,
      },
    });

    // 3. Run worker
    await runWorkerOnce({ workerId: "fail-worker" });

    // 4. Verify log
    const logs = getTestLogs();
    const finalFailLog = logs.find((l: any) => l.eventType === "JOB_PROCESS_FAILED_FINAL");

    expect(finalFailLog).toBeDefined();
    expect(finalFailLog.level).toBe("error");
    expect(typeof finalFailLog.durationMs).toBe("number");
    expect(finalFailLog.attempts).toBe(1);
    expect(finalFailLog.maxAttempts).toBe(1);
    expect(finalFailLog.jobStatus).toBe("FAILED");
    expect(finalFailLog.providerMessageId).toBe(`job-${job.id}`);
    expect(finalFailLog.error).toBe("Twilio down");
    expect(finalFailLog.lastError).toBe("Twilio down");
    expect(finalFailLog.type).toBe("AI_REPLY_REQUESTED");
    expect(finalFailLog.jobId).toBe(job.id);
    expect(finalFailLog.conversationId).toBe(conv.id);
  });
});
