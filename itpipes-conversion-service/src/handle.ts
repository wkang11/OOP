import {
  classifyFailure,
  describeFailure,
  isDeadlineExceeded,
} from "./errors.js";
import {
  noopTelemetry,
  type HandlerDeps,
  type Job,
  type JobRecord,
  type QueueMessage,
} from "./types.js";

/**
 * Per-message handler. The task's poll loop receives up to N messages and invokes this
 * concurrently, and SQS delivers at least once, so two invocations for the same job can be
 * in flight on two workers at the same moment. Every write below therefore goes through a
 * conditional put and only ever writes fields this handler owns; a handler that loses the
 * race writes nothing.
 *
 * CHANGED: the positional `(message, store, converter, clock)` signature became
 * `(message, deps)` because deadlines, the attempt budget, and telemetry have to be injected
 * per environment and per job kind.
 */
export async function handle(message: QueueMessage, deps: HandlerDeps): Promise<void> {
  const { store, converter, clock, config, telemetry = noopTelemetry } = deps;

  const record = await store.get(message.jobId);
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
  if (record.status === "running" && (record.leaseExpiresAt ?? 0) > now) {
    // A live lease means another worker is mid-conversion. Starting a second one would run
    // the same 40 GB export twice and give two writers the same job. Put the message back
    // instead; if that owner dies, the lease expires and the next delivery claims it.
    telemetry.emit({
      name: "job.lease_held",
      jobId: record.id,
      kind: record.kind,
      attempt: record.attempt,
      receiveCount: message.receiveCount,
    });
    await message.retry();
    return;
  }

  const attempt = record.attempt + 1;
  if (attempt > config.maxAttempts) {
    // Backstop: a job should have been failed at its last attempt, so reaching here means the
    // queue kept redelivering past the budget. Make it terminal rather than convert again.
    await finalize(record, attempt - 1, "failed", deps, {
      error: `attempt budget of ${config.maxAttempts} exhausted`,
      classification: "transient",
    });
    await message.ack();
    return;
  }

  const deadlineMs = config.deadlineMs[record.kind];
  const claimed = await store.put(
    {
      ...identity(record),
      status: "running",
      attempt,
      leaseExpiresAt: now + deadlineMs + config.leaseGraceMs,
    },
    record.version,
  );
  if (!claimed) {
    // Someone claimed it between our read and our write. Their lease now governs the job.
    telemetry.emit({
      name: "job.claim_conflict",
      jobId: record.id,
      kind: record.kind,
      attempt,
      receiveCount: message.receiveCount,
    });
    await message.retry();
    return;
  }

  // Per-attempt result keys. With a single `jobs/{id}/result.json` a slow attempt that
  // finishes after a newer one has published overwrites the good bytes even when the job
  // record is correct. Writing to a per-attempt key makes the object immutable and makes the
  // conditional put below the single atomic point at which a result becomes the result.
  const outputKey = `jobs/${record.id}/attempts/${attempt}/result.json`;
  const startedAt = clock.now();
  telemetry.emit({
    name: "job.started",
    jobId: record.id,
    kind: record.kind,
    attempt,
    receiveCount: message.receiveCount,
  });

  const conversion = converter.start(record.inputKey, outputKey);
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

  const durationMs = clock.now() - startedAt;

  if (failure === undefined) {
    const published = await finalize(claimed, attempt, "succeeded", deps, {
      outputKey,
      durationMs,
    });
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
  if (classification === "transient" && attempt < config.maxAttempts) {
    // Release the lease so the redelivery can claim the job immediately, and hand ownership
    // of the wait back to the queue's visibility timeout.
    const released = await store.put(
      { ...identity(claimed), status: "queued", attempt },
      claimed.version,
    );
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
    await message.retry();
    return;
  }

  // Permanent failures stop on the first attempt: retrying "required table missing" twice more
  // buys nothing and, for an export, costs tens of minutes of a 2 GB slot each time.
  const failed = await finalize(claimed, attempt, "failed", deps, {
    error: describeFailure(failure),
    classification,
    durationMs,
  });
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

/** The fields the handler never rewrites, carried forward explicitly rather than spread. */
function identity(record: JobRecord): Pick<Job, "id" | "kind" | "inputKey"> {
  return { id: record.id, kind: record.kind, inputKey: record.inputKey };
}

async function finalize(
  record: JobRecord,
  attempt: number,
  status: "succeeded" | "failed",
  deps: HandlerDeps,
  extra: {
    outputKey?: string;
    error?: string;
    classification?: "permanent" | "transient";
    durationMs?: number;
  },
): Promise<boolean> {
  const { store, telemetry = noopTelemetry } = deps;
  const written = await store.put(
    {
      ...identity(record),
      status,
      attempt,
      ...(extra.outputKey ? { outputKey: extra.outputKey } : {}),
      ...(extra.error ? { error: extra.error } : {}),
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
