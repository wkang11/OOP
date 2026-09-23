import type { FailureClass } from "./errors.js";

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

/**
 * A stored job plus the optimistic-concurrency token the store maintains.
 *
 * Items written before `version` existed read as version 0, so a service already under load
 * can adopt conditional writes without stranding its backlog.
 */
export interface JobRecord extends Job {
  readonly version: number;
}

/**
 * The fields this handler owns. `null` means REMOVE the attribute; an absent field is left
 * alone. Everything else on the item — the idempotency key, the TTL attribute, anything a
 * future caller adds — is never touched by a worker.
 */
export interface JobUpdate {
  status: JobStatus;
  attempt: number;
  leaseExpiresAt?: number | null;
  outputKey?: string | null;
  error?: string | null;
}

export interface JobStore {
  /**
   * CHANGED: takes a consistency option. The worker's pre-claim read must be strongly
   * consistent; an eventually consistent read returns a stale `version`, loses the claim, and
   * turns a normal delivery into a deferral. The API's read-for-polling can stay eventual.
   */
  get(id: string, options?: { consistentRead?: boolean }): Promise<JobRecord | undefined>;
  /**
   * CHANGED: `put(job)` -> a conditional, partial `update`.
   *
   * One DynamoDB `UpdateItem`: `SET` for the fields present, `REMOVE` for the ones set to
   * `null`, under `ConditionExpression: attribute_not_exists(version) OR version = :expected`
   * with `ReturnValues: ALL_NEW`. Resolves with the new record, or `undefined` when the
   * condition failed because somebody else wrote the job since we read it.
   *
   * It must be a partial update rather than a whole-item write: a worker that replaces the
   * item destroys the idempotency-key attribute the API depends on and the TTL attribute that
   * enforces 90-day retention.
   */
  update(id: string, changes: JobUpdate, expectedVersion: number): Promise<JobRecord | undefined>;
}

export interface QueueMessage {
  jobId: string;
  /**
   * SQS `ApproximateReceiveCount`. Retained for observability and as a poison-pill backstop,
   * but it is no longer the retry counter: duplicate deliveries and deferrals inflate it
   * without any work having been attempted. The retry budget is the stored `Job.attempt`, and
   * the queue's `maxReceiveCount` is set well above it.
   */
  receiveCount: number;
  ack(): Promise<void>;
  /**
   * CHANGED: takes an explicit visibility delay (`ChangeMessageVisibility`). Without it a
   * released retry cannot come back before the queue's visibility timeout, which for exports
   * is longer than the alarm that pages on backlog age; and a delivery deferred behind a live
   * lease comes back early and burns receives.
   */
  retry(visibleInSeconds: number): Promise<void>;
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
  | "job.stale_write_discarded"
  | "job.unclassified_failure"
  | "job.handler_error";

export interface HandlerEvent {
  name: HandlerEventName;
  jobId: string;
  kind?: JobKind;
  attempt?: number;
  receiveCount?: number;
  durationMs?: number;
  classification?: FailureClass;
  detail?: string;
}

/**
 * CHANGED: added. Every branch below is a thing an operator needs a count of; emitting them
 * from the one place that knows the outcome is cheaper than reconstructing it from logs.
 * The deployed implementation writes CloudWatch EMF to stdout, with `kind` and
 * `classification` as dimensions and everything else as properties (see DESIGN.md §4).
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
