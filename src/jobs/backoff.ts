/**
 * Exponential backoff with a 60-second cap.
 * delayMs = min(2^attempts * 1000, 60_000)
 */
export function calcBackoffMs(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * 1000, 60_000);
}
