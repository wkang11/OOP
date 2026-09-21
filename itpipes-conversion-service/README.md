# ITpipes legacy file conversion service — platform homework

- **[DESIGN.md](./DESIGN.md)** — the design review (risks, smallest v1 changes, job lifecycle, operations/deployment/observability, sizing and cost).
- **[NOTES.md](./NOTES.md)** — assumptions, what I did not fix and why, where I stopped, and how AI was used.
- `src/` — the revised worker handler and its interfaces.
- `src/legacy/original-handler.ts` — the starter worker, verbatim, kept so the tests can run against it.
- `test/` — in-memory fakes and two test suites.

## Running the tests

Requires Node 20 or newer. No AWS credentials, no Docker, no JVM, and no network access beyond the install.

```bash
cd itpipes-conversion-service
npm install
npm test          # vitest run — 21 tests
npm run typecheck # tsc --noEmit
```

`npm run test:watch` runs vitest in watch mode.

## What the tests prove

The suite is in two halves. `test/handle.test.ts` asserts the guarantees of the revised handler. `test/original-handler.test.ts` runs the *unmodified* starter worker against the same fakes and asserts the buggy behaviour it produces today, so "these tests would have failed before the change" is executable rather than a claim — each legacy test names the revised test that asserts the opposite. All of it uses in-memory fakes for `JobStore`, `QueueMessage`, `Converter`, and `Clock`, with a manually advanced clock, so there are no real timers and no flakiness.

### `test/handle.test.ts`

| Test | What it proves |
|---|---|
| runs one conversion when two deliveries arrive concurrently | Two `handle()` calls for the same job, interleaved, start exactly one conversion. The loser's conditional claim is rejected and it returns its message to the queue. |
| defers a delivery while another worker holds a live lease | A duplicate delivery for a job with an unexpired lease does not convert; once the lease expires the next delivery claims the job, so a dead worker cannot strand it in `running`. |
| discards a slow attempt's result once a newer attempt has published | An attempt that finishes after the job has moved on cannot repoint `outputKey` or roll the attempt counter backwards; the write is rejected and counted. |
| uses the per-kind deadline instead of a fixed 30 seconds | Imports get 15 minutes and exports 120 minutes, and healthy long jobs succeed. |
| terminates and reaps the subprocess when the deadline expires | On timeout `kill()` is called exactly once and no conversion is left alive, before the message becomes visible again. |
| cancels the deadline timer when the conversion finishes first | No timer is left armed after a successful conversion. |
| survives the subprocess rejecting after the deadline decided the outcome | A late rejection from a killed child does not surface as an `unhandledRejection` that would take down a task still working on other messages. |
| fails a permanent converter error on the first attempt | Exit 2 ("required table missing") goes straight to `failed` with no retry and no second conversion. |
| retries a transient converter error and leaves the job claimable | Exit 137 releases the lease back to `queued` and retries the message. |
| counts stored attempts, not `receiveCount` | A job whose `receiveCount` is 5 because of duplicate deliveries still gets its full attempt budget. |
| gives up once the stored attempt budget is spent | The third attempt's transient failure is terminal. |
| acks deliveries for unknown and already-terminal jobs | Preserved from the original; guards against a regression that would re-run finished work. |

### `test/original-handler.test.ts` (defects pinned against the starter code)

Two concurrent deliveries start two conversions for one job; a slow attempt overwrites a newer attempt's published result and rolls the attempt counter back; every job gets a 30-second deadline, so a healthy export times out; the timed-out subprocess is never killed or reaped and the job is left in `running`; the deadline timer stays armed after success; exit 2 is retried exactly like exit 137; and duplicate deliveries inflate `receiveCount` so a job is marked `failed` on its first real attempt.
