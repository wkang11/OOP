import { describe, expect, it } from "vitest";

import { handle } from "../src/handle.js";
import { defaultConfig } from "../src/index.js";
import type { HandlerDeps } from "../src/types.js";
import {
  config,
  FakeConverter,
  FakeQueueMessage,
  flush,
  InMemoryJobStore,
  ManualClock,
  RecordingTelemetry,
} from "./fakes.js";

function harness(overrides: Partial<ReturnType<typeof config>> = {}) {
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
    expect(job?.outputKey).toBe("jobs/job-1/attempts/1/result.json");
  });

  it("defers a delivery while another worker holds a live lease", async () => {
    const { store, converter, clock, telemetry, deps } = harness();
    store.seed({ id: "job-2", status: "running", attempt: 1, leaseExpiresAt: 5_000 });

    const message = new FakeQueueMessage("job-2", 2);
    await handle(message, deps);

    expect(converter.started).toHaveLength(0);
    expect(message.retries).toBe(1);
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
    await store.put(
      {
        id: "job-3",
        kind: "export",
        inputKey: claimed.inputKey,
        status: "succeeded",
        attempt: 2,
        outputKey: "jobs/job-3/attempts/2/result.json",
      },
      claimed.version,
    );

    converter.last().finish();
    await running;

    const job = store.snapshot("job-3");
    expect(job?.attempt).toBe(2);
    expect(job?.outputKey).toBe("jobs/job-3/attempts/2/result.json");
    expect(telemetry.count("job.stale_write_discarded")).toBe(1);
    // The message is still removed: the job has an owner and a result, so redelivery is waste.
    expect(message.acks).toBe(1);
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
    try {
      const { store, clock, deps } = harness();
      store.seed({ id: "job-6" });
      const running = handle(new FakeQueueMessage("job-6"), deps);
      await flush();
      await clock.advance(defaultConfig.deadlineMs.import + 1);
      await running;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
    expect(telemetry.events.find((e) => e.name === "job.failed")?.classification).toBe(
      "permanent",
    );
  });

  it("retries a transient converter error and leaves the job claimable", async () => {
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
    expect(message.retries).toBe(1);
    expect(message.acks).toBe(0);
  });

  it("counts stored attempts, not receiveCount inflated by duplicate deliveries", async () => {
    const { store, converter, deps } = harness();
    store.seed({ id: "job-9", attempt: 0 });

    // Three deliveries have happened, but no conversion has been attempted yet.
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
