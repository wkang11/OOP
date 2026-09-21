export { handle } from "./handle.js";
export * from "./types.js";
export * from "./errors.js";

import type { HandlerConfig } from "./types.js";

/**
 * Deadlines are generous on purpose: their job is to bound a hung subprocess, not to enforce
 * a latency SLO. An import "normally takes seconds to several minutes" against a file up to
 * 2 GB, and an export runs tens of minutes for a 10-40 GB package, so the deadline sits well
 * above the slowest healthy job. Anything tighter fails healthy work, which is exactly what
 * the shipped 30 s did.
 *
 * Operational constraint that goes with these numbers: the SQS visibility timeout for each
 * queue must be at least `deadlineMs + leaseGraceMs`, refreshed by a heartbeat, or the queue
 * redelivers a job that is still running.
 */
export const defaultConfig: HandlerConfig = {
  deadlineMs: {
    import: 15 * 60_000,
    export: 120 * 60_000,
  },
  maxAttempts: 3,
  leaseGraceMs: 2 * 60_000,
};
