import { AggregatorService } from "./aggregator.service.js";
import { logger } from "../observability/logger.js";
import { AggregatorState } from "./aggregator.state.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main loop for the metrics aggregator.
 * Aligns to minute boundaries and aggregates the previous full minute window.
 */
async function main(): Promise<void> {
  logger.info({ msg: "Metrics Aggregator Runner starting" });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = new Date();
    // Calculate ms until next minute boundary
    const nextMinute = new Date(
      Math.floor(now.getTime() / 60_000) * 60_000 + 60_000,
    );
    const sleepMs = nextMinute.getTime() - now.getTime();

    await sleep(sleepMs);

    const start = Date.now();
    const windowStart = new Date(nextMinute.getTime() - 60_000);
    const windowEnd = nextMinute;

    try {
      await AggregatorService.aggregateWindow(windowStart);

      const durationMs = Date.now() - start;
      AggregatorState.update({
        lastRunAt: new Date(),
        lastWindowStart: windowStart,
        lastDurationMs: durationMs,
        lastError: null,
      });

      logger.info({
        eventType: "AGGREGATOR_TICK",
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        sleepMs,
        durationMs,
      });
    } catch (err: any) {
      const durationMs = Date.now() - start;
      AggregatorState.update({
        lastRunAt: new Date(),
        lastWindowStart: windowStart,
        lastDurationMs: durationMs,
        lastError: err?.message || "Unknown error",
      });

      logger.error({
        eventType: "AGGREGATOR_RUNNER_ERROR",
        error: err?.message,
        windowStart: windowStart.toISOString(),
        durationMs,
      });
    }
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
