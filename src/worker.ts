import { randomUUID } from "crypto";
import { logger } from "./observability/logger.js";
import { claimNextJobs } from "./jobs/claim.js";
import { processJob } from "./jobs/process.js";

export interface WorkerOptions {
  batchSize?: number;
  workerId?: string;
}

/**
 * Run the worker once: claim a batch of pending jobs and process each one.
 * Exported for use in tests and as a composable building block.
 * Does NOT import from server.ts; safe to run standalone.
 */
export async function runWorkerOnce(opts: WorkerOptions = {}): Promise<void> {
  const workerId = opts.workerId ?? `worker-${randomUUID()}`;
  const batchSize = opts.batchSize ?? 10;

  const workerLogger = logger.child({ workerId });

  const jobs = await claimNextJobs(workerId, batchSize);

  if (jobs.length === 0) {
    return;
  }

  workerLogger.info({ eventType: "JOB_CLAIMED", count: jobs.length, workerId });

  for (const job of jobs) {
    await processJob(job);
  }
}

/**
 * Standalone entry-point: polls for jobs every `intervalMs`.
 * NOT imported from server.ts. Start manually with `node dist/worker.js`.
 */
async function main(): Promise<void> {
  const intervalMs = 5_000;
  logger.info({ msg: "Worker starting", intervalMs });

  // eslint-disable-next-line no-constant-condition
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
  process.argv[1].endsWith("worker.js");

if (isEntryPoint) {
  main().catch((err) => {
    logger.error({ msg: "Worker fatal error", error: err?.message });
    process.exit(1);
  });
}
