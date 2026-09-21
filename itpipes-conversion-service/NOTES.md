# Notes

## Assumptions

The problem statement is incomplete on purpose, so these are the gaps I filled rather than invented requirements.

- **Runtimes.** Import mean 3 minutes ("seconds to several minutes"), export mean 30 minutes ("tens of minutes"), mean package 20 GB (stated range 10–40 GB). All sizing and every deadline follows from these; they are the first numbers I would replace with measurements.
- **Deadlines bound hangs, they do not enforce an SLO.** 15 minutes for imports and 120 minutes for exports are deliberately far above the slowest healthy job. A tight deadline fails valid work, which is the failure mode the current code already has.
- **Results are derived data.** They can be regenerated from inputs the customer owns, so a 14-day lifecycle expiry is acceptable and the 90-day retention requirement applies to job metadata, not to 40 GB zips. If a customer contract actually requires 90-day package retention, the monthly bill goes from ~$2,100 to ~$9,400 and that trade is theirs to make.
- **Consumers read packages in-region**, so S3 internet egress is ~zero. If not, egress becomes a top-three line item.
- **The converter wrapper surfaces exit codes.** `RunningConversion.completion` is `Promise<void>`, so the handler cannot see why a conversion failed. I assume the wrapper (which we are allowed to write) rejects with an error carrying `exitCode`; `src/errors.ts` defines that shape and the permanent/transient mapping. The mapping is currently one entry — exit 2 is permanent — because that is the only permanent code the observations name.
- **`kill()` terminates *and* reaps.** The handler awaits it and treats resolution as "the child is gone and its memory is back". A wrapper that only sends SIGTERM and returns would satisfy the type and break the guarantee.
- **Exports are not resumable.** A failed attempt restarts from zero. At 200 exports/day, resumability costs more to build and operate than the wasted compute it saves.
- **Job ids are caller-visible and the idempotency key maps to one job id** via a GSI, so a retried submit returns the existing job rather than enqueueing a second one.

## Interface changes and why

- `JobStore.put(job)` → `put(job, expectedVersion)` returning the new record or `undefined`. Without a conditional write there is no way to make "only one worker owns this job" true, and the fix for duplicate delivery and for stale publication is the same primitive. It maps to one DynamoDB `UpdateItem` with a condition expression.
- `Job` gained `kind` and `leaseExpiresAt`. `kind` is needed to choose a deadline (and, in the deployed system, a queue and a task size); `leaseExpiresAt` is what lets a duplicate delivery distinguish "another worker is converting right now" from "the previous owner died".
- `Clock.timeout(ms): Promise<never>` → `timeout(ms): Deadline` with `{ expired, cancel() }`. The promise still only rejects, so the original contract holds. What was missing is cancellation — ten concurrent messages each holding an uncancelled 120-minute timer keep timers and their closures alive for the life of the task — and a distinguishable rejection, so the handler can tell "deadline expired, kill the child" from "the converter failed on its own". `now()` was added for lease arithmetic.
- `handle(message, store, converter, clock)` → `handle(message, deps)`. Deadlines, the attempt budget, and telemetry have to be injected per environment; a fifth and sixth positional parameter is worse than an object.
- Added a `Telemetry` seam with a no-op default. Every branch in the handler is something an operator needs a count of, and the metric names in DESIGN.md §4 are these event names. It does not change control flow.

## What I did not fix, and why

Ordered by how much it bothers me.

1. **The visibility-timeout heartbeat.** The lease is only correct if the queue does not redeliver a message while its owner is still working. That requires the worker's poll loop to call `ChangeMessageVisibility` on a timer, and the poll loop is not in scope here (the assignment gives the per-message handler only). The lease degrades safely without it — a duplicate delivery is deferred rather than duplicated — but the message churns. This is the first thing I would write next.
2. **Nothing guarantees a terminal state when a worker dies.** The handler cannot fix this from inside; it needs the sweeper Lambda described in DESIGN.md §2 to fail jobs whose lease expired with no message in flight, plus DLQ drainage into `failed`. Today a caller polling a job whose worker was killed sees `running` until a redelivery happens.
3. **Store writes are not retried.** A throttled or failed `put` propagates out of `handle()` and the message is redelivered. That is correct but crude: after the conversion has already run, losing the result to a transient DynamoDB error means paying for the whole export again. A bounded retry around the terminal write only is the cheap fix.
4. **Result objects are written by the converter, not by the handler.** The handler passes an `outputKey` and trusts that a resolved completion means the bytes are durably there. A converter that resolves before its multipart upload completes would let the handler publish a pointer to a non-existent object. In the real wrapper I would either do the upload in the handler or have the converter return the uploaded ETag/size and verify with a `HeadObject`.
5. **Orphans from a previous task generation are not swept.** `kill()` handles the process this handler started. A task that is SIGKILLed leaves the JVM to the container teardown; a `pid 1` that reaps children and an ECS `stopTimeout` are the operational answer, not handler code.
6. **The permanent/transient table is thin.** One exit code, plus "everything else is transient". Real converters have a richer vocabulary (corrupt media, unsupported schema version, disk full), and misclassifying "disk full" as permanent would fail valid jobs. I would build that table from a month of DLQ samples rather than guess it now.
7. **No structured reason codes on failures.** Callers get a stringified error, truncated to 1 KB. A stable `reasonCode` enum is what other teams' backends actually want to branch on.
8. **No webhook code.** DESIGN.md moves delivery to a DynamoDB-stream Lambda; I did not write it.
9. **No backpressure on the claim conflict path.** A deferred delivery goes back to the queue with the default visibility timeout. Ideally it would come back after the lease expires, not before, via `ChangeMessageVisibility(remainingLeaseMs)`, which would need a parameter on `QueueMessage.retry()`. It is a cost optimisation, not a correctness issue.
10. **No load or soak test.** The concurrency argument in DESIGN.md §1 (10 × 2 GB on a 4 GB task) is arithmetic, not a measurement. Before v1 I would run one onboarding-shaped burst against the real converters and check memory high-water marks per slot.

## Remaining risks in what I did write

- **The lease is only as good as the clock.** `leaseExpiresAt` uses worker wall-clock time; badly skewed clocks would let two workers both believe a lease has expired. On Fargate with a managed time source this is acceptable; a stricter design would store a monotonic fencing token (the `attempt` number already serves this purpose for writes) rather than a timestamp.
- **The attempt budget can be spent by infrastructure.** Three attempts are shared between converter failures and worker deaths, so three unlucky task recycles fail a valid job. Distinguishing "failed because the converter said so" from "failed because the platform dropped us" would need separate counters.
- **Deadline expiry counts as an attempt and is transient**, so a job whose deadline is genuinely too short burns all three attempts and 45 minutes before failing. The `job.deadline_exceeded` alarm exists specifically to catch that configuration error before customers do.

## Where I stopped

Inside the timebox. Part 1 is complete. Part 2 fixes the two risks I judged most urgent — single-writer ownership of a job, and the timeout path (per-kind deadline plus terminate-and-reap) — with the permanent/transient split folded in because the same `catch` block had to be rewritten and leaving exit 2 to burn three attempts would have made the change incoherent. What I would do in the next hour, in order: the heartbeat in the poll loop, the sweeper Lambda, and a bounded retry on the terminal write.

## How AI was used

This submission was produced by working with an AI coding agent throughout, so the honest answer is "for most of the typing". The useful part is what was accepted and what was not.

**What I asked for.** A first-pass reading of the starter handler against the workload facts and the production observations, with the bugs ranked; a draft of the design review section by section; the in-memory fakes and the test scaffolding; and the cost arithmetic laid out so I could check it. I also asked for an adversarial pass on my own conclusions — "what would a reviewer attack here" — which is where several of the entries in "what I did not fix" came from.

**What I accepted.** The fakes and most of the test scaffolding, which are mechanical. The structure of the handler's claim/publish flow. The idea of keeping the original handler in-tree and writing characterization tests against it, which I think is the strongest thing in the repo: it turns "these tests would have failed before" into something a reviewer can run. Most of the Fargate and S3 unit prices, after checking them.

**What I rejected or corrected.**

- **A corrupted source copy produced a confident, wrong bug report.** The first pass worked from a plain-text export of the assignment that had silently stripped TypeScript generic parameters. On that copy `Clock.timeout` looked like it could *resolve*, which would have meant `Promise.race` taking the success branch and a timed-out job being recorded as `succeeded` — a dramatic bug, written up in detail, and not real. Against the authoritative signature, `Promise<never>` cannot resolve, so the contract is that it rejects and the true defect is the mundane one the observations point at: the `catch` path calls `retry()` without ever calling `kill()`. That analysis was discarded and redone. The lesson I am keeping is that the agent was happy to build a confident argument on a corrupted premise and had no way to notice the premise was corrupted; the types in front of it were the only check, and I had handed it the wrong ones.
- **Fixing everything.** The first plan repaired all seven defects in one pass. The assignment asks for the smallest change addressing the one or two most urgent risks, and a pull request that rewrites a handler end to end is harder to review and riskier to ship than one that does two things. Scoped back to ownership and the timeout path; the rest moved into the list above.
- **A compute-first cost model.** The first cut of the sizing section assumed Fargate dominated the bill, because that is where the interesting capacity reasoning is. Doing the storage arithmetic reversed it: compute is ~7% and S3 is ~91%, and the NAT-gateway-versus-VPC-endpoint decision alone is worth more than the entire Fargate bill. The conclusion — one lifecycle rule is the highest-value change on the page — only exists because the arithmetic got written out.
- **Service padding.** Several drafts wanted to reach for more AWS services. The two that stayed (a DynamoDB stream for webhooks, a scheduled Lambda for the sweeper) each remove a specific failure mode that is named in the lifecycle section. Anything that did not remove a failure mode was cut.
- **Comments that narrate the code.** Trimmed throughout; the ones left explain why a branch exists or what contract it depends on, which is the part a future reader cannot recover from the code.
