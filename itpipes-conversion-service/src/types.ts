/**
 * Seams between the worker handler and the job store, the queue, and the converters.
 *
 * Changes from the starter interfaces are marked CHANGED and justified in NOTES.md.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * CHANGED: added. Imports run for seconds to minutes; exports run for tens of minutes and
 * need a different deadline, a different lease, and (in the deployed system) a different
 * queue and task size. The handler cannot make any of those choices without knowing which
 * converter it is about to run.
 */
export type JobKind = "import" | "export";

export interface Job {
  id: string;
  kind: JobKind;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  outputKey?: string;
  error?: string;
  /**
   * CHANGED: added. Wall-clock ms after which a job in `running` may be claimed by another
   * worker. Set by whoever claims the job; it is what lets a duplicate delivery tell "another
   * worker is mid-conversion" from "the previous owner died".
   */
  leaseExpiresAt?: number;
}

/** A stored job plus the optimistic-concurrency token the store maintains. */
export interface JobRecord extends Job {
  readonly version: number;
}

export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>;
  /**
   * CHANGED: `put(job)` -> conditional `put(job, expectedVersion)`.
   *
   * Resolves with the stored record (version incremented) when `expectedVersion` still matches,
   * and with `undefined` when it does not, meaning somebody else has written the job since we
   * read it and our write was rejected. One DynamoDB UpdateItem with
   * `ConditionExpression: "version = :expected"` and `ReturnValues: ALL_NEW` implements this.
   */
  put(job: Job, expectedVersion: number): Promise<JobRecord | undefined>;
}

export interface QueueMessage {
  jobId: string;
  /**
   * SQS `ApproximateReceiveCount`. Retained for observability and as a poison-pill backstop,
   * but it is no longer the retry counter: duplicate deliveries inflate it without any work
   * having been attempted. The retry budget is the stored `Job.attempt`.
   */
  receiveCount: number;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export interface RunningConversion {
  completion: Promise<void>;
  /**
   * Terminate and reap the conversion. Contract the handler relies on: resolves only once the
   * child process has exited and been waited on (SIGTERM, short grace, SIGKILL, waitpid), and
   * is a safe no-op if the child has already exited.
   */
  kill(): Promise<void>;
}

export interface Converter {
  start(inputKey: string, outputKey: string): RunningConversion;
}

/**
 * CHANGED: `Clock.timeout(ms): Promise<never>` -> `Clock.timeout(ms): Deadline`.
 *
 * The promise still only ever rejects, so the original contract is intact. Two things were
 * missing: a way to cancel the timer when the conversion finishes first (10 concurrent
 * messages each holding an uncancelled 40-minute timer keeps timers and their closures alive
 * for the life of the task), and a distinguishable rejection so the handler can tell "deadline
 * expired, kill the child" from "the converter itself failed".
 */
export interface Deadline {
  /** Rejects with {@link DeadlineExceededError} when the deadline passes. Never resolves. */
  expired: Promise<never>;
  cancel(): void;
}

export interface Clock {
  /** CHANGED: added, for lease expiry arithmetic. */
  now(): number;
  timeout(ms: number): Deadline;
}

export interface HandlerConfig {
  /** Per-kind conversion deadline. The shipped 30 s is shorter than a normal import. */
  deadlineMs: Record<JobKind, number>;
  /** Maximum stored attempts before a transient failure becomes terminal. */
  maxAttempts: number;
  /** Added to the deadline when taking a lease, to cover process start and result upload. */
  leaseGraceMs: number;
}

export type HandlerEventName =
  | "job.unknown_id"
  | "job.already_terminal"
  | "job.lease_held"
  | "job.claim_conflict"
  | "job.started"
  | "job.succeeded"
  | "job.failed"
  | "job.retry_scheduled"
  | "job.deadline_exceeded"
  | "job.kill_failed"
  | "job.stale_write_discarded";

export interface HandlerEvent {
  name: HandlerEventName;
  jobId: string;
  kind?: JobKind;
  attempt?: number;
  receiveCount?: number;
  durationMs?: number;
  classification?: "permanent" | "transient";
  detail?: string;
}

/**
 * CHANGED: added. Every branch below is a thing an operator needs a count of; emitting them
 * from the one place that knows the outcome is cheaper than reconstructing it from logs.
 * The deployed implementation writes CloudWatch EMF to stdout.
 */
export interface Telemetry {
  emit(event: HandlerEvent): void;
}

export const noopTelemetry: Telemetry = { emit() {} };

export interface HandlerDeps {
  store: JobStore;
  converter: Converter;
  clock: Clock;
  config: HandlerConfig;
  telemetry?: Telemetry;
}
