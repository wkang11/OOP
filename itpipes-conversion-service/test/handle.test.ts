import { describe, expect, it } from "vitest";

import { handle } from "../src/handle.js";
import { defaultConfig } from "../src/index.js";
import type { HandlerConfig, HandlerDeps } from "../src/types.js";
import {
  config,
  FakeConverter,
  FakeQueueMessage,
  flush,
  InMemoryJobStore,
  ManualClock,
  RecordingTelemetry,
} from "./fakes.js";

function harness(overrides: Partial<HandlerConfig> = {}) {
  const store = new InMemoryJobStore();
  const converter = new FakeConverter();
  const clock = new ManualClock();
  const telemetry = new RecordingTelemetry();
  const deps: HandlerDeps = {
    store,
    converter,
    clock,
    telemetry,
    config: config(overrides),
  };
  return { store, converter, clock, telemetry, deps };
}

describe("single-writer discipline", () => {
  it("runs one conversion when two deliveries for the same job arrive concurrently", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-1", kind: "export" });
    const first = new FakeQueueMessage("job-1");
    const second = new FakeQueueMessage("job-1");

    const running = Promise.all([handle(first, deps), handle(second, deps)]);
    await flush();

    expect(converter.started).toHaveLength(1);

    converter.last().finish();
    await running;

    // The loser puts its message back rather than converting a second 10-40 GB package.
    expect(first.retries + second.retries).toBe(1);
    expect(first.acks + second.acks).toBe(1);
    const job = store.snapshot("job-1");
    expect(job?.status).toBe("succeeded");
    expect(job?.attempt).toBe(1);
    expect(job?.outputKey).toBe("exports/job-1/attempts/1/package.zip");
  });

  it("reads the record strongly consistently before claiming", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-1b" });
    const running = handle(new FakeQueueMessage("job-1b"), deps);
    await flush();
    converter.last().finish();
    await running;

    // An eventually consistent read returns a stale version, loses the claim, and turns an
    // ordinary delivery into a deferral.
    expect(store.reads[0]).toEqual({ id: "job-1b", consistentRead: true });
  });

  it("defers a delivery for exactly as long as the live lease has left", async () => {
    const { store, converter, clock, telemetry, deps } = harness();
    store.seed({ id: "job-2", status: "running", attempt: 1, leaseExpiresAt: 5_000 });

    const message = new FakeQueueMessage("job-2", 2);
    await handle(message, deps);

    expect(converter.started).toHaveLength(0);
    expect(message.retries).toBe(1);
    // Coming back before the lease expires would burn a receive for nothing.
    expect(message.retryDelays).toEqual([5]);
    expect(message.acks).toBe(0);
    expect(telemetry.count("job.lease_held")).toBe(1);

    // Once the lease expires the job is claimable again, so a dead worker cannot strand it.
    await clock.advance(6_000);
    const later = new FakeQueueMessage("job-2", 3);
    const running = handle(later, deps);
    await flush();
    expect(converter.started).toHaveLength(1);
    expect(store.snapshot("job-2")?.attempt).toBe(2);
    converter.last().finish();
    await running;
    expect(store.snapshot("job-2")?.status).toBe("succeeded");
  });

  it("discards a slow attempt's result once a newer attempt has published", async () => {
    const { store, converter, telemetry, deps } = harness();
    const seeded = store.seed({ id: "job-3", kind: "export" });

    const message = new FakeQueueMessage("job-3");
    const running = handle(message, deps);
    await flush();
    expect(converter.started).toHaveLength(1);

    // While this attempt is still converting, another worker (or the sweeper) moves the job on.
    const claimed = store.snapshot("job-3")!;
    expect(claimed.version).toBe(seeded.version + 1);
    await store.update(
      "job-3",
      {
        status: "succeeded",
        attempt: 2,
        outputKey: "exports/job-3/attempts/2/package.zip",
        leaseExpiresAt: null,
      },
      claimed.version,
    );

    converter.last().finish();
    await running;

    const job = store.snapshot("job-3");
    expect(job?.attempt).toBe(2);
    expect(job?.outputKey).toBe("exports/job-3/attempts/2/package.zip");
    expect(telemetry.count("job.stale_write_discarded")).toBe(1);
    // The message is still removed: the job has an owner and a result, so redelivery is waste.
    expect(message.acks).toBe(1);
  });

  it("preserves attributes the worker does not own", async () => {
    const { store, converter, deps } = harness();
    store.seed(
      { id: "job-3b" },
      { attributes: { idempotencyKey: "caller-key-1", expiresAt: 1_900_000_000 } },
    );

    const running = handle(new FakeQueueMessage("job-3b"), deps);
    await flush();
    converter.last().finish();
    await running;

    // A whole-item write would take the idempotency key and the TTL attribute with it, so
    // re-submission would double-enqueue and job metadata would never expire.
    const raw = store.raw("job-3b")!;
    expect(raw.idempotencyKey).toBe("caller-key-1");
    expect(raw.expiresAt).toBe(1_900_000_000);
    expect(raw.status).toBe("succeeded");
    expect(raw.leaseExpiresAt).toBeUndefined();
  });

  it("claims a record written before the version attribute existed", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-3c", kind: "import" }, { unversioned: true });

    const running = handle(new FakeQueueMessage("job-3c"), deps);
    await flush();
    // Rows from before this change read as version 0 and must still be claimable, or the
    // existing backlog can never be worked.
    expect(converter.started).toHaveLength(1);
    converter.last().finish();
    await running;

    expect(store.snapshot("job-3c")?.status).toBe("succeeded");
    expect(store.snapshot("job-3c")?.version).toBe(2);
  });
});

describe("deadlines", () => {
  it("uses the per-kind deadline instead of a fixed 30 seconds", async () => {
    const importCase = harness();
    importCase.store.seed({ id: "imp", kind: "import" });
    const importRun = handle(new FakeQueueMessage("imp"), importCase.deps);
    await flush();
    importCase.converter.last().finish();
    await importRun;

    const exportCase = harness();
    exportCase.store.seed({ id: "exp", kind: "export" });
    const exportRun = handle(new FakeQueueMessage("exp"), exportCase.deps);
    await flush();
    exportCase.converter.last().finish();
    await exportRun;

    expect(importCase.clock.requested).toEqual([defaultConfig.deadlineMs.import]);
    expect(exportCase.clock.requested).toEqual([defaultConfig.deadlineMs.export]);
    expect(importCase.store.snapshot("imp")?.status).toBe("succeeded");
    expect(exportCase.store.snapshot("exp")?.status).toBe("succeeded");
  });

  it("terminates and reaps the subprocess when the deadline expires", async () => {
    const { store, converter, clock, telemetry, deps } = harness();
    store.seed({ id: "job-4", kind: "import" });

    const message = new FakeQueueMessage("job-4");
    const running = handle(message, deps);
    await flush();
    const conversion = converter.last();
    expect(conversion.alive).toBe(true);
    // The lease covers the deadline plus the shipped grace, so a peer defers for the whole run.
    expect(store.snapshot("job-4")?.leaseExpiresAt).toBe(
      defaultConfig.deadlineMs.import + defaultConfig.leaseGraceMs,
    );

    await clock.advance(defaultConfig.deadlineMs.import + 1);
    await running;

    expect(conversion.killCount).toBe(1);
    expect(converter.liveCount).toBe(0);
    expect(telemetry.count("job.deadline_exceeded")).toBe(1);
    // A deadline is transient, and the lease is released so the redelivery can claim at once.
    expect(store.snapshot("job-4")?.status).toBe("queued");
    expect(store.snapshot("job-4")?.attempt).toBe(1);
    expect(store.snapshot("job-4")?.leaseExpiresAt).toBeUndefined();
    expect(message.retries).toBe(1);
    expect(message.retryDelays).toEqual([0]);
  });

  it("cancels the deadline timer when the conversion finishes first", async () => {
    const { store, converter, clock, deps } = harness();
    store.seed({ id: "job-5" });

    const running = handle(new FakeQueueMessage("job-5"), deps);
    await flush();
    converter.last().finish();
    await running;

    expect(clock.liveTimers).toBe(0);
  });

  it("survives the subprocess rejecting after the deadline decided the outcome", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let conversion;
    try {
      const { store, converter, clock, deps } = harness();
      store.seed({ id: "job-6" });
      const running = handle(new FakeQueueMessage("job-6"), deps);
      await flush();
      conversion = converter.last();
      await clock.advance(defaultConfig.deadlineMs.import + 1);
      await running;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Positive control: the late rejection has to have actually happened, or this test would
    // pass just as well against a conversion that never settles.
    expect(conversion?.settled).toBe("rejected");
    expect(unhandled).toEqual([]);
  });
});

describe("failure classification and the retry budget", () => {
  it("fails a permanent converter error on the first attempt", async () => {
    const { store, converter, telemetry, deps } = harness();
    store.seed({ id: "job-7", kind: "export" });

    const message = new FakeQueueMessage("job-7");
    const running = handle(message, deps);
    await flush();
    converter.last().failWith(2, "required table missing");
    await running;

    const job = store.snapshot("job-7");
    expect(job?.status).toBe("failed");
    expect(job?.attempt).toBe(1);
    expect(job?.error).toContain("required table missing");
    expect(job?.outputKey).toBeUndefined();
    expect(message.retries).toBe(0);
    expect(message.acks).toBe(1);
    expect(converter.started).toHaveLength(1);
    expect(telemetry.find("job.failed")?.classification).toBe("permanent");
  });

  it("retries a transient converter error immediately and leaves the job claimable", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-8" });

    const message = new FakeQueueMessage("job-8");
    const running = handle(message, deps);
    await flush();
    converter.last().failWith(137);
    await running;

    const job = store.snapshot("job-8");
    expect(job?.status).toBe("queued");
    expect(job?.attempt).toBe(1);
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(message.retries).toBe(1);
    // Without the explicit zero the retry waits out the visibility timeout — 125 minutes for
    // an export, which trips the backlog-age alarm on an ordinary retry.
    expect(message.retryDelays).toEqual([0]);
    expect(message.acks).toBe(0);
  });

  it("counts stored attempts, not receiveCount inflated by duplicate deliveries", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-9", attempt: 0 });

    // Five deliveries have happened, but no conversion has been attempted yet.
    const message = new FakeQueueMessage("job-9", 5);
    const running = handle(message, deps);
    await flush();
    converter.last().failWith(137);
    await running;

    expect(store.snapshot("job-9")?.status).toBe("queued");
    expect(message.retries).toBe(1);
  });

  it("gives up once the stored attempt budget is spent", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-10", attempt: 2 });

    const message = new FakeQueueMessage("job-10", 1);
    const running = handle(message, deps);
    await flush();
    converter.last().failWith(137);
    await running;

    const job = store.snapshot("job-10");
    expect(job?.status).toBe("failed");
    expect(job?.attempt).toBe(3);
    expect(message.acks).toBe(1);
  });

  it("gives an unclassified failure one retry, not the whole budget", async () => {
    const first = harness();
    first.store.seed({ id: "job-10b", attempt: 0 });
    const firstMessage = new FakeQueueMessage("job-10b");
    const firstRun = handle(firstMessage, first.deps);
    await flush();
    first.converter.last().failUnclassified();
    await firstRun;

    expect(first.store.snapshot("job-10b")?.status).toBe("queued");
    expect(first.telemetry.count("job.unclassified_failure")).toBe(1);

    // A wrapper that has stopped reporting exit codes must not turn every permanent failure
    // into a full budget of re-runs, so the second unclassified failure is terminal.
    const second = harness();
    second.store.seed({ id: "job-10c", attempt: 1 });
    const secondMessage = new FakeQueueMessage("job-10c");
    const secondRun = handle(secondMessage, second.deps);
    await flush();
    second.converter.last().failUnclassified();
    await secondRun;

    expect(second.store.snapshot("job-10c")?.status).toBe("failed");
    expect(second.store.snapshot("job-10c")?.attempt).toBe(2);
    expect(secondMessage.acks).toBe(1);
  });
});

describe("a seam that throws", () => {
  it("does not strand the job under a live lease when a store write fails", async () => {
    const { store, converter, telemetry, deps } = harness();
    store.seed({ id: "job-11" });
    store.failUpdate = (changes) =>
      changes.status === "succeeded" ? new Error("ProvisionedThroughputExceeded") : undefined;

    const message = new FakeQueueMessage("job-11");
    const running = handle(message, deps);
    await flush();
    converter.last().finish();
    await expect(running).resolves.toBeUndefined();

    const job = store.snapshot("job-11");
    expect(telemetry.count("job.handler_error")).toBe(1);
    expect(job?.status).toBe("queued");
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(message.retries).toBe(1);
    expect(message.acks).toBe(0);
  });

  it("releases the lease when the converter will not start", async () => {
    const { store, converter, telemetry, deps } = harness();
    store.seed({ id: "job-12", kind: "export" });
    converter.failToStart = new Error("spawn EAGAIN");

    const message = new FakeQueueMessage("job-12");
    await expect(handle(message, deps)).resolves.toBeUndefined();

    expect(telemetry.count("job.handler_error")).toBe(1);
    expect(store.snapshot("job-12")?.status).toBe("queued");
    expect(store.snapshot("job-12")?.leaseExpiresAt).toBeUndefined();
    expect(message.retries).toBe(1);
  });
});

describe("messages with nothing to do", () => {
  it("acks a delivery for an unknown job", async () => {
    const { converter, telemetry, deps } = harness();
    const message = new FakeQueueMessage("missing");
    await handle(message, deps);
    expect(message.acks).toBe(1);
    expect(converter.started).toHaveLength(0);
    expect(telemetry.count("job.unknown_id")).toBe(1);
  });

  it("acks a delivery for a job that is already terminal", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "done", status: "succeeded", attempt: 1 });
    const message = new FakeQueueMessage("done", 2);
    await handle(message, deps);
    expect(message.acks).toBe(1);
    expect(converter.started).toHaveLength(0);
  });
});
