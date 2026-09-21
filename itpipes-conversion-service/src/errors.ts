export class DeadlineExceededError extends Error {
  override readonly name = "DeadlineExceededError";
  constructor(readonly deadlineMs: number) {
    super(`conversion exceeded its ${deadlineMs} ms deadline`);
  }
}

/**
 * What a converter wrapper should reject `RunningConversion.completion` with. The starter
 * interface types completion as `Promise<void>`, so the exit code never reaches the handler
 * and exit 2 (invalid database, permanent) is indistinguishable from exit 137 (killed,
 * transient). The wrapper owns the mapping; the handler only needs the code.
 */
export class ConversionFailedError extends Error {
  override readonly name = "ConversionFailedError";
  constructor(
    readonly exitCode: number,
    message = `conversion exited with code ${exitCode}`,
  ) {
    super(message);
  }
}

export type FailureClass = "permanent" | "transient";

/**
 * Exit codes that mean "this input will never convert, no matter how many times we try".
 * Exit 2 is the vendor writer's "required table missing". Everything else, including 137
 * (128 + SIGKILL, i.e. the cgroup OOM killer) and an expired deadline, is treated as
 * transient: retrying is the cheaper mistake when the alternative is failing a valid job.
 */
const PERMANENT_EXIT_CODES: ReadonlySet<number> = new Set([2]);

export function isDeadlineExceeded(error: unknown): boolean {
  return (
    error instanceof DeadlineExceededError ||
    (error instanceof Error && error.name === "DeadlineExceededError")
  );
}

export function classifyFailure(error: unknown): FailureClass {
  if (isDeadlineExceeded(error)) return "transient";
  const exitCode = (error as { exitCode?: unknown } | null | undefined)?.exitCode;
  if (typeof exitCode === "number") {
    return PERMANENT_EXIT_CODES.has(exitCode) ? "permanent" : "transient";
  }
  return "transient";
}

const MAX_ERROR_CHARS = 1024;

/** Job records are read by callers and stored in DynamoDB, so the text is bounded. */
export function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
