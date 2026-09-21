/**
 * Characterization tests for the starter worker in `src/legacy/original-handler.ts`.
 *
 * Every assertion here pins a defect: the expectations describe what the shipped code does
 * today, not what it should do. Each test names the test in `handle.test.ts` that asserts the
 * opposite behaviour, so "these tests would have failed before the change" is executable
 * rather than a claim. Deleting the legacy file should delete this file with it.
 */

import { describe, expect, it } from "vitest";

import { handle as originalHandle } from "../src/legacy/original-handler.js";
import {
  FakeConverter,
  FakeQueueMessage,
  flush,
  InMemoryJobStore,
  ManualClock,
} from "./fakes.js";

function legacyHarness() {
  const store = new InMemoryJobStore();
  const converter = new FakeConverter();
  const clock = new ManualClock();
  const run = (message: FakeQueueMessage) =>
    originalHandle(message, store.legacy, converter, clock.legacy);
  return { store, converter, clock, run };
}

it("BUG: two concurrent deliveries start two conversions for the same job", async () => {
  // Contrast: "runs one conversion when two deliveries for the same job arrive concurrently".
  const { store, converter, run } = legacyHarness();
  store.seed({ id: "job-1", kind: "export" });

  const running = Promise.all([
    run(new FakeQueueMessage("job-1")),
    run(new FakeQueueMessage("job-1")),
  ]);
  await flush();

  // Two 10-40 GB exports for one job, on two workers, both writing the same result key.
  expect(converter.started).toHaveLength(2);

  for (const conversion of converter.conversions) conversion.finish();
  await running;
});

it("BUG: a slow attempt overwrites a newer attempt's published result", async () => {
  // Contrast: "discards a slow attempt's result once a newer attempt has published".
  const { store, converter, run } = legacyHarness();
  store.seed({ id: "job-3", kind: "export" });

  const running = run(new FakeQueueMessage("job-3"));
  await flush();

  const claimed = store.snapshot("job-3")!;
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

  // The unconditional put of a stale in-memory snapshot rolls the job back an attempt and
  // repoints outputKey at the shared key this attempt wrote.
  const job = store.snapshot("job-3");
  expect(job?.attempt).toBe(1);
  expect(job?.outputKey).toBe("jobs/job-3/result.json");
});

it("BUG: every job gets a 30 s deadline, including a tens-of-minutes export", async () => {
  // Contrast: "uses the per-kind deadline instead of a fixed 30 seconds".
  const { store, converter, clock, run } = legacyHarness();
  store.seed({ id: "exp", kind: "export" });

  const message = new FakeQueueMessage("exp");
  const running = run(message);
  await flush();

  expect(clock.requested).toEqual([30_000]);

  await clock.advance(30_001);
  await running;

  // A perfectly healthy export is now a retry.
  expect(message.retries).toBe(1);
  expect(converter.last().alive).toBe(true);
});

it("BUG: a timed-out conversion is never killed or reaped", async () => {
  // Contrast: "terminates and reaps the subprocess when the deadline expires".
  const { store, converter, clock, run } = legacyHarness();
  store.seed({ id: "job-4", kind: "import" });

  const running = run(new FakeQueueMessage("job-4"));
  await flush();
  await clock.advance(30_001);
  await running;

  const orphan = converter.last();
  expect(orphan.killCount).toBe(0);
  expect(orphan.alive).toBe(true);
  expect(converter.liveCount).toBe(1);
  // The job is left in `running` with nobody working on it, so a caller polling the API sees
  // a job that never moves until a later delivery happens to pick it up.
  expect(store.snapshot("job-4")?.status).toBe("running");
});

it("BUG: an uncancelled timer stays armed after the conversion finishes", async () => {
  // Contrast: "cancels the deadline timer when the conversion finishes first".
  const { store, converter, clock, run } = legacyHarness();
  store.seed({ id: "job-5" });

  const running = run(new FakeQueueMessage("job-5"));
  await flush();
  converter.last().finish();
  await running;

  expect(clock.liveTimers).toBe(1);
});

it("BUG: a permanent failure (exit 2) is retried like a transient one", async () => {
  // Contrast: "fails a permanent converter error on the first attempt".
  const { store, converter, run } = legacyHarness();
  store.seed({ id: "job-7", kind: "export" });

  const message = new FakeQueueMessage("job-7");
  const running = run(message);
  await flush();
  converter.last().failWith(2, "required table missing");
  await running;

  expect(message.retries).toBe(1);
  expect(store.snapshot("job-7")?.status).toBe("running");
});

it("BUG: duplicate deliveries inflate receiveCount and fail a job on its first attempt", async () => {
  // Contrast: "counts stored attempts, not receiveCount inflated by duplicate deliveries".
  const { store, converter, run } = legacyHarness();
  store.seed({ id: "job-9", attempt: 0 });

  const message = new FakeQueueMessage("job-9", 3);
  const running = run(message);
  await flush();
  converter.last().failWith(137);
  await running;

  const job = store.snapshot("job-9");
  expect(job?.status).toBe("failed");
  // Its first and only real conversion attempt, marked permanently failed.
  expect(job?.attempt).toBe(1);
});

describe("behaviour the revised handler keeps", () => {
  it("acks a delivery for an unknown job", async () => {
    const { converter, run } = legacyHarness();
    const message = new FakeQueueMessage("missing");
    await run(message);
    expect(message.acks).toBe(1);
    expect(converter.started).toHaveLength(0);
  });
});
