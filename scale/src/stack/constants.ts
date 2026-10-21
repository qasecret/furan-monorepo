/**
 * BullMQ key prefix of the diff queue. The api enqueues on it and the worker
 * consumes it, so both must use this one value; it also keeps the harness's
 * jobs apart from a dev stack's on the same Redis.
 */
export const QUEUE_PREFIX = "furan-scale";

/** Key namespace of the api's shared rate-limit store. */
export const RATE_LIMIT_NAMESPACE = "furan-scale:";

/** Every Redis key the harness owns starts with this. */
export const REDIS_KEY_PATTERN = "furan-scale:*";

/** Diff jobs run in parallel (the production worker's default; P4's ideal). */
export const WORKER_CONCURRENCY = 4;
