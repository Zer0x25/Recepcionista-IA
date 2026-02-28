import { jest } from "@jest/globals";
// Mock dependencies before imports
jest.unstable_mockModule("../../src/jobs/claim.js", () => ({
  claimNextJobs: jest.fn(),
}));
jest.unstable_mockModule("../../src/jobs/process.js", () => ({
  processJob: jest.fn(),
}));

const { prisma } = await import("../../src/persistence/prisma.js");
const { runWorkerOnce, resetHeartbeatState } = await import("../../src/worker.js");
const { claimNextJobs } = (await import("../../src/jobs/claim.js")) as any;

describe("Worker Heartbeat", () => {
  const workerId = "test-worker-heartbeat";

  beforeEach(async () => {
    jest.clearAllMocks();
    resetHeartbeatState();
    await prisma.workerHeartbeat.deleteMany();
    await prisma.job.deleteMany();
    await prisma.message.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should create heartbeat on first run", async () => {
    claimNextJobs.mockResolvedValue([]);

    await runWorkerOnce({ workerId });

    const hb = await prisma.workerHeartbeat.findUnique({
      where: { workerId },
    });

    expect(hb).toBeDefined();
    expect(hb?.claimedCount).toBe(0);
    expect(hb?.lastSeenAt).toBeDefined();
  });

  it("should increment claimedCount across multiple runs", async () => {
    claimNextJobs
      .mockResolvedValueOnce([{ id: "job-1" }])
      .mockResolvedValueOnce([{ id: "job-2" }, { id: "job-3" }]);

    // Force heartbeat interval by mocking Date.now
    const now = Date.now();
    const dateSpy = jest.spyOn(Date, "now");

    // First run
    dateSpy.mockReturnValue(now);
    await runWorkerOnce({ workerId });

    // Second run + 16s later
    dateSpy.mockReturnValue(now + 16_000);
    await runWorkerOnce({ workerId });

    const hb = await prisma.workerHeartbeat.findUnique({
      where: { workerId },
    });

    expect(hb?.claimedCount).toBe(3);
    dateSpy.mockRestore();
  });

  it("should not update heartbeat if interval has not passed", async () => {
    claimNextJobs.mockResolvedValue([]);

    const now = Date.now();
    const dateSpy = jest.spyOn(Date, "now");

    // First heartbeat at T=0
    dateSpy.mockReturnValue(now);
    await runWorkerOnce({ workerId });
    const hb1 = await prisma.workerHeartbeat.findUnique({
      where: { workerId },
    });

    // Second run at T=5s - should NOT update
    dateSpy.mockReturnValue(now + 5_000);
    await runWorkerOnce({ workerId });
    const hb2 = await prisma.workerHeartbeat.findUnique({
      where: { workerId },
    });

    expect(hb1?.updatedAt).toEqual(hb2?.updatedAt);
    dateSpy.mockRestore();
  });
});
