import {
  classifyFailure,
  describeFailure,
  isDeadlineExceeded,
  type FailureClass,
} from "./errors.js";
import {
  noopTelemetry,
  type HandlerDeps,
  type JobRecord,
  type QueueMessage,
  type RunningConversion,
} from "./types.js";

/** Fields a new attempt must not inherit from the previous one. */
const CLEAR_ATTEMPT_OUTPUT = { outputKey: null, error: null } as const;

/** A failure the wrapper could not classify gets one retry, not the full budget. */
const UNCLASSIFIED_ATTEMPT_LIMIT = 2;

interface HandlerState {
  attempt?: number;
  claimed?: JobRecord;
  conversion?: RunningConversion;
}

/**
 * Per-message handler. The task's poll loop receives up to N messages and invokes this
 * concurrently, and SQS delivers at least once, so two invocations for the same job can be in
 * flight on two workers at the same moment. Every write goes through a conditional update of
 * only the fields this handler owns; a handler that loses the race writes nothing.
 *
 * CHANGED: the positional `(message, store, converter, clock)` signature became
 * `(message, deps)` because deadlines, the attempt budget, and telemetry have to be injected
 * per environment and per job kind.
 */
export async function handle(message: QueueMessage, deps: HandlerDeps): Promise<void> {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const state: HandlerState = {};

  try {
    await run(message, deps, state);
  } catch (error) {
    // Any seam can throw: a throttled conditional write, a queue client that fails to ack, a
    // converter that will not launch. Without this the message is left in flight and the job
    // sits in `running` under a live lease, so every redelivery defers instead of working and
    // the sweeper cannot act for up to the lease duration.
    telemetry.emit({
      name: "job.handler_error",
      jobId: message.jobId,
      attempt: state.attempt,
      detail: describeFailure(error),
    });
    if (state.conversion) await swallow(state.conversion.kill());
    if (state.claimed && state.attempt !== undefined) {
      await swallow(
        deps.store.update(
          state.claimed.id,
          {
            status: "queued",
            attempt: state.attempt,
            leaseExpiresAt: null,
            ...CLEAR_ATTEMPT_OUTPUT,
          },
          state.claimed.version,
        ),
      );
    }
    await swallow(message.retry(0));
  }
}

async function run(
  message: QueueMessage,
  deps: HandlerDeps,
  state: HandlerState,
): Promise<void> {
  const { store, converter, clock, config } = deps;
  const telemetry = deps.telemetry ?? noopTelemetry;

  // Strongly consistent: a stale read loses the conditional claim below and turns an ordinary
  // delivery into a deferral.
  const record = await store.get(message.jobId, { consistentRead: true });
  if (!record) {
    telemetry.emit({ name: "job.unknown_id", jobId: message.jobId });
    await message.ack();
    return;
  }

  if (record.status === "succeeded" || record.status === "failed") {
    telemetry.emit({ name: "job.already_terminal", jobId: record.id, kind: record.kind });
    await message.ack();
    return;
  }

  const now = clock.now();
  const leaseExpiresAt = record.leaseExpiresAt ?? 0;
  if (record.status === "running" && leaseExpiresAt > now) {
    // Another worker is mid-conversion. Starting a second one would run the same 40 GB export
    // twice. Hand the message back, invisible until the lease expires, so the deferral costs
    // one receive rather than one per visibility timeout.
    telemetry.emit({
      name: "job.lease_held",
      jobId: record.id,
      kind: record.kind,
      attempt: record.attempt,
      receiveCount: message.receiveCount,
    });
    await message.retry(Math.ceil((leaseExpiresAt - now) / 1000));
    return;
  }

  const attempt = record.attempt + 1;
  state.attempt = attempt;

  if (attempt > config.maxAttempts) {
    // Backstop: the job should have been failed at its last attempt, so reaching here means
    // the queue kept redelivering past the budget. Make it terminal rather than convert again.
    await finalize(record, attempt - 1, "failed", deps, {
      error: `attempt budget of ${config.maxAttempts} exhausted`,
      classification: "transient",
    });
    await message.ack();
    return;
  }

  const deadlineMs = config.deadlineMs[record.kind];
  const claimed = await store.update(
    record.id,
    {
      status: "running",
      attempt,
      leaseExpiresAt: now + deadlineMs + config.leaseGraceMs,
      ...CLEAR_ATTEMPT_OUTPUT,
    },
    record.version,
  );
  if (!claimed) {
    telemetry.emit({
      name: "job.claim_conflict",
      jobId: record.id,
      kind: record.kind,
      attempt,
      receiveCount: message.receiveCount,
    });
    // Come straight back: the next receive reads the winner's lease and defers for its
    // remainder, which is the only point at which we know how long to wait.
    await message.retry(0);
    return;
  }
  state.claimed = claimed;

  // Per-attempt result keys, under a per-kind prefix so one S3 lifecycle rule can expire
  // export packages without deleting the import JSON that future exports read. With a single
  // `result.json` a slow attempt that finishes after a newer one overwrites the good bytes
  // even when the job record is correct.
  const outputKey = resultKey(claimed, attempt);
  const startedAt = clock.now();
  telemetry.emit({
    name: "job.started",
    jobId: record.id,
    kind: record.kind,
    attempt,
    receiveCount: message.receiveCount,
  });

  const conversion = converter.start(record.inputKey, outputKey);
  state.conversion = conversion;
  // The child may reject after the deadline has already decided the outcome. Observing the
  // promise here keeps that late rejection off `unhandledRejection`, which would take down a
  // task that is still converting other messages.
  void conversion.completion.catch(() => {});

  const deadline = clock.timeout(deadlineMs);
  let failure: unknown;
  try {
    await Promise.race([conversion.completion, deadline.expired]);
  } catch (error) {
    failure = error ?? new Error("conversion failed without an error value");
  } finally {
    deadline.cancel();
  }

  if (failure !== undefined) {
    if (isDeadlineExceeded(failure)) {
      telemetry.emit({
        name: "job.deadline_exceeded",
        jobId: record.id,
        kind: record.kind,
        attempt,
        durationMs: clock.now() - startedAt,
        detail: `deadlineMs=${deadlineMs}`,
      });
    }
    // A timed-out subprocess keeps running unless its owner terminates and reaps it. It must
    // be gone before the message becomes visible again, or the redelivery converts alongside
    // it and the two ~2 GB children OOM the task (exit 137). Also covers a converter that
    // rejects while leaving its child alive; kill is a no-op once the child has exited.
    try {
      await conversion.kill();
    } catch (killError) {
      telemetry.emit({
        name: "job.kill_failed",
        jobId: record.id,
        kind: record.kind,
        attempt,
        detail: describeFailure(killError),
      });
    }
  }
  state.conversion = undefined;

  const durationMs = clock.now() - startedAt;

  if (failure === undefined) {
    const published = await finalize(claimed, attempt, "succeeded", deps, {
      outputKey,
      durationMs,
    });
    state.claimed = undefined;
    if (!published) {
      telemetry.emit({
        name: "job.stale_write_discarded",
        jobId: record.id,
        kind: record.kind,
        attempt,
        detail: "result superseded by a newer attempt",
      });
    }
    await message.ack();
    return;
  }

  const classification = classifyFailure(failure);
  if (classification === "unclassified") {
    telemetry.emit({
      name: "job.unclassified_failure",
      jobId: record.id,
      kind: record.kind,
      attempt,
      detail: describeFailure(failure),
    });
  }

  const budget =
    classification === "unclassified"
      ? Math.min(UNCLASSIFIED_ATTEMPT_LIMIT, config.maxAttempts)
      : config.maxAttempts;

  if (classification !== "permanent" && attempt < budget) {
    // Release the lease and clear this attempt's output, then make the message visible
    // immediately. Without the explicit zero the retry cannot come back before the queue's
    // visibility timeout, which for exports is longer than the alarm that pages on backlog age.
    const released = await store.update(
      claimed.id,
      { status: "queued", attempt, leaseExpiresAt: null, ...CLEAR_ATTEMPT_OUTPUT },
      claimed.version,
    );
    state.claimed = undefined;
    if (!released) {
      telemetry.emit({
        name: "job.stale_write_discarded",
        jobId: record.id,
        kind: record.kind,
        attempt,
        detail: "job reclaimed by another worker; not retrying",
      });
      await message.ack();
      return;
    }
    telemetry.emit({
      name: "job.retry_scheduled",
      jobId: record.id,
      kind: record.kind,
      attempt,
      receiveCount: message.receiveCount,
      classification,
      durationMs,
      detail: describeFailure(failure),
    });
    await message.retry(0);
    return;
  }

  // Permanent failures stop on the first attempt: retrying "required table missing" buys
  // nothing and, for an export, costs tens of minutes of a 2 GB slot each time.
  const failed = await finalize(claimed, attempt, "failed", deps, {
    error: describeFailure(failure),
    classification,
    durationMs,
  });
  state.claimed = undefined;
  if (!failed) {
    telemetry.emit({
      name: "job.stale_write_discarded",
      jobId: record.id,
      kind: record.kind,
      attempt,
      detail: "failure superseded by a newer attempt",
    });
  }
  await message.ack();
}

export function resultKey(job: { id: string; kind: string }, attempt: number): string {
  const suffix = job.kind === "export" ? "package.zip" : "result.json";
  return `${job.kind}s/${job.id}/attempts/${attempt}/${suffix}`;
}

async function finalize(
  record: JobRecord,
  attempt: number,
  status: "succeeded" | "failed",
  deps: HandlerDeps,
  extra: {
    outputKey?: string;
    error?: string;
    classification?: FailureClass;
    durationMs?: number;
  },
): Promise<boolean> {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const written = await deps.store.update(
    record.id,
    {
      status,
      attempt,
      leaseExpiresAt: null,
      outputKey: extra.outputKey ?? null,
      error: extra.error ?? null,
    },
    record.version,
  );
  if (!written) return false;
  telemetry.emit({
    name: status === "succeeded" ? "job.succeeded" : "job.failed",
    jobId: record.id,
    kind: record.kind,
    attempt,
    ...(extra.classification ? { classification: extra.classification } : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra.error ? { detail: extra.error } : {}),
  });
  return true;
}

function swallow<T>(promise: Promise<T>): Promise<T | undefined> {
  return promise.catch(() => undefined);
}
