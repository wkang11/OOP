/**
 * In-memory doubles for the four seams. No AWS, no Docker, no JVM, no real timers.
 *
 * Each fake also exposes a `legacy` view shaped like the starter interfaces, so the same
 * scenario can be pointed at `src/legacy/original-handler.ts` and at the revised handler.
 */

import { ConversionFailedError, DeadlineExceededError } from "../src/errors.js";
import type {
  Clock,
  Converter,
  Deadline,
  HandlerEvent,
  Job,
  JobKind,
  JobRecord,
  JobStore,
  QueueMessage,
  RunningConversion,
  Telemetry,
} from "../src/types.js";
import type {
  Clock as LegacyClock,
  Job as LegacyJob,
  JobStore as LegacyJobStore,
} from "../src/legacy/original-handler.js";

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  readonly writes: JobRecord[] = [];
  conflicts = 0;

  constructor(...seed: Array<Partial<Job> & { id: string }>) {
    for (const job of seed) this.seed(job);
  }

  seed(job: Partial<Job> & { id: string }): JobRecord {
    const record: JobRecord = {
      kind: "import",
      inputKey: `uploads/${job.id}.mdb`,
      status: "queued",
      attempt: 0,
      ...job,
      version: 1,
    };
    this.jobs.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const record = this.jobs.get(id);
    return record ? { ...record } : undefined;
  }

  async put(job: Job, expectedVersion: number): Promise<JobRecord | undefined> {
    const current = this.jobs.get(job.id);
    if (!current || current.version !== expectedVersion) {
      this.conflicts += 1;
      return undefined;
    }
    const record: JobRecord = { ...job, version: current.version + 1 };
    this.jobs.set(job.id, record);
    this.writes.push(record);
    return { ...record };
  }

  snapshot(id: string): JobRecord | undefined {
    const record = this.jobs.get(id);
    return record ? { ...record } : undefined;
  }

  /** The starter store: unconditional whole-object writes, no version. */
  get legacy(): LegacyJobStore {
    return {
      get: async (id: string): Promise<LegacyJob | undefined> => this.snapshot(id),
      put: async (job: LegacyJob): Promise<void> => {
        const current = this.jobs.get(job.id);
        const record = {
          ...(current ?? {}),
          ...(job as Job),
          version: (current?.version ?? 0) + 1,
        } as JobRecord;
        this.jobs.set(job.id, record);
        this.writes.push(record);
      },
    };
  }
}

export class FakeQueueMessage implements QueueMessage {
  acks = 0;
  retries = 0;

  constructor(
    readonly jobId: string,
    public receiveCount = 1,
  ) {}

  async ack(): Promise<void> {
    this.acks += 1;
  }

  async retry(): Promise<void> {
    this.retries += 1;
  }
}

export class FakeConversion implements RunningConversion {
  readonly completion: Promise<void>;
  killCount = 0;
  /** True until the child exits, however it exits. Mirrors a live OS process. */
  alive = true;

  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor() {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  finish(): void {
    if (!this.alive) return;
    this.alive = false;
    this.resolve();
  }

  failWith(exitCode: number, message?: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.reject(new ConversionFailedError(exitCode, message));
  }

  async kill(): Promise<void> {
    this.killCount += 1;
    if (this.alive) {
      this.alive = false;
      // A killed child still settles its completion promise; the handler must survive that
      // rejection arriving after it has already decided the outcome.
      this.reject(new ConversionFailedError(137, "terminated by worker"));
    }
  }
}

export class FakeConverter implements Converter {
  readonly started: Array<{ inputKey: string; outputKey: string }> = [];
  readonly conversions: FakeConversion[] = [];

  start(inputKey: string, outputKey: string): RunningConversion {
    this.started.push({ inputKey, outputKey });
    const conversion = new FakeConversion();
    this.conversions.push(conversion);
    return conversion;
  }

  get liveCount(): number {
    return this.conversions.filter((c) => c.alive).length;
  }

  last(): FakeConversion {
    const conversion = this.conversions.at(-1);
    if (!conversion) throw new Error("no conversion started");
    return conversion;
  }
}

interface PendingDeadline {
  firesAt: number;
  ms: number;
  cancelled: boolean;
  fired: boolean;
  reject: (error: unknown) => void;
}

export class ManualClock implements Clock {
  readonly requested: number[] = [];
  private readonly pending: PendingDeadline[] = [];

  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  timeout(ms: number): Deadline {
    this.requested.push(ms);
    const entry: PendingDeadline = {
      firesAt: this.current + ms,
      ms,
      cancelled: false,
      fired: false,
      reject: () => {},
    };
    const expired = new Promise<never>((_resolve, reject) => {
      entry.reject = reject;
    });
    this.pending.push(entry);
    return {
      expired,
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /** Advance time and fire every deadline that is now due. */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (const entry of this.pending) {
      if (entry.cancelled || entry.fired || entry.firesAt > this.current) continue;
      entry.fired = true;
      entry.reject(new DeadlineExceededError(entry.ms));
    }
    await flush();
  }

  /** Timers still armed. A handler that forgets to cancel leaves these behind. */
  get liveTimers(): number {
    return this.pending.filter((entry) => !entry.cancelled && !entry.fired).length;
  }

  /** The starter clock: a bare rejecting promise with no way to cancel it. */
  get legacy(): LegacyClock {
    return {
      timeout: (ms: number): Promise<never> => this.timeout(ms).expired,
    };
  }
}

export class RecordingTelemetry implements Telemetry {
  readonly events: HandlerEvent[] = [];

  emit(event: HandlerEvent): void {
    this.events.push(event);
  }

  names(): string[] {
    return this.events.map((event) => event.name);
  }

  count(name: string): number {
    return this.events.filter((event) => event.name === name).length;
  }
}

/** Let queued microtasks run, so awaited handler steps can make progress. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function config(overrides: Partial<{
  deadlineMs: Record<JobKind, number>;
  maxAttempts: number;
  leaseGraceMs: number;
}> = {}) {
  return {
    deadlineMs: { import: 15 * 60_000, export: 120 * 60_000 },
    maxAttempts: 3,
    leaseGraceMs: 60_000,
    ...overrides,
  };
}
