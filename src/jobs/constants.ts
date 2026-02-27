/**
 * How long (ms) to yield before the SENDING-collision worker retries.
 */
export const SENDING_COLLISION_BACKOFF_MS = 2_000;

/**
 * How long (ms) a message can stay in "SENDING" phase before being considered stuck.
 */
export const SENDING_TTL_MS = 60_000;
