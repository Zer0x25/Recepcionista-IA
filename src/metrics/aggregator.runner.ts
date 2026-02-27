import { AggregatorService } from "./aggregator.service.js";
import { logger } from "../observability/logger.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main loop for the metrics aggregator.
 * Runs every 60 seconds and aggregates the previous minute window.
 */
async function main(): Promise<void> {
  const intervalMs = 60_000;
  logger.info({ msg: "Metrics Aggregator Runner starting", intervalMs });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Aggregate for the minute that just passed (e.g. at 12:01:05, aggregate 12:00:00-12:01:00)
      const now = new Date();
      const previousMinute = new Date(now.getTime() - 60_000);

      await AggregatorService.aggregateWindow(previousMinute);
    } catch (err: any) {
      logger.error({
        eventType: "AGGREGATOR_RUNNER_ERROR",
        error: err?.message,
      });
    }
    await sleep(intervalMs);
  }
}

// Only runs when this file is the entry point
const isEntryPoint =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("aggregator.runner.js") ||
    process.argv[1].endsWith("aggregator.runner.ts"));

if (isEntryPoint) {
  main().catch((err) => {
    logger.error({ msg: "Aggregator Runner fatal error", error: err?.message });
    process.exit(1);
  });
}
