import { randomUUID } from "crypto";
import { logger } from "./observability/logger.js";
import { claimNextJobs } from "./jobs/claim.js";
import { processJob } from "./jobs/process.js";
import { prisma } from "./persistence/prisma.js";

export interface WorkerOptions {
  batchSize?: number;
  workerId?: string;
}

const GLOBAL_WORKER_ID = `worker-${randomUUID()}`;
let globalClaimedCountCountSinceLastHeartbeat = 0;
let lastHeartbeatTime = 0;

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Reset heartbeat state for testing.
 */
export function resetHeartbeatState(): void {
  globalClaimedCountCountSinceLastHeartbeat = 0;
  lastHeartbeatTime = 0;
}

/**
 * Run the worker once: claim a batch of pending jobs and process each one.
 * Exported for use in tests and as a composable building block.
 * Does NOT import from server.ts; safe to run standalone.
 */
export async function runWorkerOnce(opts: WorkerOptions = {}): Promise<void> {
  const workerId = opts.workerId ?? GLOBAL_WORKER_ID;
  const batchSize = opts.batchSize ?? 10;

  const workerLogger = logger.child({ workerId });

  const jobs = await claimNextJobs(workerId, batchSize);

  if (jobs.length === 0) {
    // Even if no jobs, try to heartbeat if it's time
    await performHeartbeat(workerId);
    return;
  }

  globalClaimedCountCountSinceLastHeartbeat += jobs.length;

  workerLogger.info({ eventType: "JOB_CLAIMED", count: jobs.length, workerId });

  for (const job of jobs) {
    await processJob(job);
  }

  // Check heartbeat after processing a batch
  await performHeartbeat(workerId);
}

async function performHeartbeat(workerId: string): Promise<void> {
  const now = Date.now();
  if (now - lastHeartbeatTime < HEARTBEAT_INTERVAL_MS) {
    return;
  }

  const claimedToReport = globalClaimedCountCountSinceLastHeartbeat;
  // Reset before async call to avoid double counting if multiple heartbeats trigger (unlikely here but safe)
  globalClaimedCountCountSinceLastHeartbeat = 0;
  lastHeartbeatTime = now;

  try {
    await prisma.workerHeartbeat.upsert({
      where: { workerId },
      update: {
        lastSeenAt: new Date(),
        claimedCount: { increment: claimedToReport },
      },
      create: {
        workerId,
        lastSeenAt: new Date(),
        claimedCount: claimedToReport,
      },
    });

    logger.info({
      eventType: "WORKER_HEARTBEAT",
      workerId,
      claimedDelta: claimedToReport,
    });
  } catch (err: any) {
    // If it fails, add back the claimed count so we don't lose it
    globalClaimedCountCountSinceLastHeartbeat += claimedToReport;
    logger.error({
      eventType: "WORKER_HEARTBEAT_ERROR",
      workerId,
      error: err?.message,
    });
  }
}

/**
 * Standalone entry-point: polls for jobs every `intervalMs`.
 * NOT imported from server.ts. Start manually with `node dist/worker.js`.
 */
async function main(): Promise<void> {
  const intervalMs = 5_000;
  logger.info({
    msg: "Worker starting",
    intervalMs,
    workerId: GLOBAL_WORKER_ID,
  });

  while (true) {
    try {
      await runWorkerOnce();
    } catch (err: any) {
      logger.error({ eventType: "WORKER_LOOP_ERROR", error: err?.message });
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only runs when this file is the entry point (not when imported in tests)
const isEntryPoint =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("worker.js") || process.argv[1].endsWith("worker.ts"));

if (isEntryPoint) {
  main().catch((err) => {
    logger.error({ msg: "Worker fatal error", error: err?.message });
    process.exit(1);
  });
}
