/**
 * In-memory doubles for the four seams. No AWS, no Docker, no JVM, no real timers.
 *
 * Each fake also exposes a `legacy` view shaped like the starter interfaces, so the same
 * scenario can be pointed at `src/legacy/original-handler.ts` and at the revised handler.
 */

import { ConversionFailedError, DeadlineExceededError } from "../src/errors.js";
import { defaultConfig } from "../src/index.js";
import type {
  Clock,
  Converter,
  Deadline,
  HandlerConfig,
  HandlerEvent,
  Job,
  JobRecord,
  JobStore,
  JobUpdate,
  QueueMessage,
  RunningConversion,
  Telemetry,
} from "../src/types.js";
import type {
  Clock as LegacyClock,
  Job as LegacyJob,
  JobStore as LegacyJobStore,
} from "../src/legacy/original-handler.js";

/** A stored item: the job attributes plus whatever else the API or TTL put on the row. */
type StoredItem = Partial<Job> & { id: string; version?: number } & Record<string, unknown>;

export interface SeedOptions {
  /** Omit `version`, as rows written before conditional writes existed would be. */
  unversioned?: boolean;
  /** Extra attributes the handler knows nothing about and must not destroy. */
  attributes?: Record<string, unknown>;
}

/**
 * Models one DynamoDB table: partial updates under a version condition, `null` meaning
 * REMOVE, a missing `version` reading as 0, and attributes outside `Job` left alone.
 */
export class InMemoryJobStore implements JobStore {
  private readonly items = new Map<string, StoredItem>();
  readonly writes: JobRecord[] = [];
  readonly reads: Array<{ id: string; consistentRead: boolean }> = [];
  conflicts = 0;
  /** Test hook: model a throttled or failed conditional write. */
  failUpdate: ((changes: JobUpdate) => Error | undefined) | undefined;

  seed(job: Partial<Job> & { id: string }, options: SeedOptions = {}): JobRecord {
    const item: StoredItem = {
      kind: "import",
      inputKey: `uploads/${job.id}.mdb`,
      status: "queued",
      attempt: 0,
      ...options.attributes,
      ...job,
      ...(options.unversioned ? {} : { version: 1 }),
    };
    this.items.set(item.id, item);
    return this.materialize(item);
  }

  async get(id: string, options?: { consistentRead?: boolean }): Promise<JobRecord | undefined> {
    this.reads.push({ id, consistentRead: options?.consistentRead === true });
    const item = this.items.get(id);
    return item ? this.materialize(item) : undefined;
  }

  async update(
    id: string,
    changes: JobUpdate,
    expectedVersion: number,
  ): Promise<JobRecord | undefined> {
    const failure = this.failUpdate?.(changes);
    if (failure) throw failure;
    const current = this.items.get(id);
    if (!current || (current.version ?? 0) !== expectedVersion) {
      this.conflicts += 1;
      return undefined;
    }
    const next: StoredItem = { ...current, version: (current.version ?? 0) + 1 };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    this.items.set(id, next);
    const record = this.materialize(next);
    this.writes.push(record);
    return record;
  }

  /** The raw item, including attributes outside the `Job` shape. */
  raw(id: string): StoredItem | undefined {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  snapshot(id: string): JobRecord | undefined {
    const item = this.items.get(id);
    return item ? this.materialize(item) : undefined;
  }

  private materialize(item: StoredItem): JobRecord {
    return { ...item, version: item.version ?? 0 } as JobRecord;
  }

  /** The starter store: unconditional whole-object writes, no version. */
  get legacy(): LegacyJobStore {
    return {
      get: async (id: string): Promise<LegacyJob | undefined> => this.snapshot(id),
      put: async (job: LegacyJob): Promise<void> => {
        const current = this.items.get(job.id);
        const item = { ...(job as StoredItem), version: (current?.version ?? 0) + 1 };
        this.items.set(job.id, item);
        this.writes.push(this.materialize(item));
      },
    };
  }
}

export class FakeQueueMessage implements QueueMessage {
  acks = 0;
  retries = 0;
  /** The visibility delay requested on each retry, in seconds. */
  readonly retryDelays: number[] = [];

  constructor(
    readonly jobId: string,
    public receiveCount = 1,
  ) {}

  async ack(): Promise<void> {
    this.acks += 1;
  }

  async retry(visibleInSeconds = 0): Promise<void> {
    this.retries += 1;
    this.retryDelays.push(visibleInSeconds);
  }
}

export class FakeConversion implements RunningConversion {
  readonly completion: Promise<void>;
  killCount = 0;
  /** True until the child exits, however it exits. Mirrors a live OS process. */
  alive = true;
  /** Set when the completion promise settles, so a test can prove a late rejection happened. */
  settled: "resolved" | "rejected" | undefined;

  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor() {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.completion.then(
      () => {
        this.settled = "resolved";
      },
      () => {
        this.settled = "rejected";
      },
    );
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

  /** A crash the wrapper could not attach an exit code to. */
  failUnclassified(message = "wrapper lost the exit code"): void {
    if (!this.alive) return;
    this.alive = false;
    this.reject(new Error(message));
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
  /** When set, `start` throws — a converter that will not launch. */
  failToStart: Error | undefined;

  start(inputKey: string, outputKey: string): RunningConversion {
    if (this.failToStart) throw this.failToStart;
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

  find(name: string): HandlerEvent | undefined {
    return this.events.find((event) => event.name === name);
  }
}

/** Let queued microtasks run, so awaited handler steps can make progress. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** The shipped configuration, so tests exercise the values that actually deploy. */
export function config(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
  return { ...defaultConfig, ...overrides };
}
