# Onsite prep: ITpipes conversion service

60-minute design and code review. Expect a substantial part of the hour on deployment, metrics, and
observability, and expect new evidence introduced mid-session. Read §0 and §1 the morning of; skim §2
for the questions you feel least ready for.

---

## 0. The walkthrough — how to narrate the system

This is the spine of the conversation. They will almost certainly open with "walk me through it," and
how you sequence it decides whether the rest of the hour is you explaining or you defending.

**Open with the framing, not the diagram** (about fifteen seconds). Callers hand us S3 references over
HTTP and we hand back S3 references; bytes never travel through the API. Two workload shapes share
one pipeline — an import is seconds to minutes, an export is tens of minutes — and nearly every
problem in the proposed v1 traces back to that difference being unacknowledged in the queue, the
fleet, the task size, and the timeout. Say that first. It tells them you found the organizing idea
rather than a list of bugs.

### An import, end to end

1. **Submit.** `POST /jobs` with the kind, the input S3 key, and a caller-supplied idempotency key.
2. **Create the record.** The API Lambda writes the job to DynamoDB as a conditional write on an item
   keyed by the idempotency key — deliberately *not* a GSI lookup, because index reads are never
   strongly consistent, so two concurrent submissions with the same key would both miss the index and
   create two jobs. Status `queued`, attempt 0. Returns `202` and the job id.
3. **Enqueue.** A message carrying only `{jobId}` goes to the **imports** queue. The record stays the
   single source of truth, so a message can never carry stale state.
4. **Claim.** An import worker — Fargate, 2 vCPU / 8 GB, two slots — reads the record with
   `ConsistentRead` (a stale read would lose the claim it is about to attempt), then claims it with a
   conditional update to `running`, `attempt = n+1`, and a lease expiry. The condition is on a
   `version` attribute. **If the condition fails, another worker owns the job and this one returns its
   message without converting.** That single sentence is the whole answer to duplicate delivery.
5. **Convert** in-process under a 15-minute deadline.
6. **Publish the object first.** JSON goes to `imports/{id}/attempts/{n}/result.json` — a per-attempt
   key, so result objects are immutable and no attempt can overwrite another's bytes.
7. **Then publish the record.** A conditional write to `succeeded` pointing at that key. Object first,
   record second, so the record never advertises bytes that do not exist. That conditional write is
   the single atomic moment at which a result becomes *the* result.
8. **Ack** the message.

### What changes for an export

Its own queue and fleet; **one** slot per task rather than two, because disk binds before memory — a
40 GB package needs ~100 GiB of scratch against 200 GiB attached; a 120-minute deadline; the vendor
JVM as a subprocess whose exit code the wrapper surfaces; a multipart upload of the finished zip; a
125-minute visibility timeout heartbeated every 60 seconds; and task scale-in protection so neither a
deploy nor a scale-in event can kill 40 minutes of work. Everything else is identical, which is the
point — I split the queues, fleets, and sizing, not the code.

### Then volunteer the failure paths, before they ask

This is where the hour is won, so do not wait to be asked.

- **Two deliveries 100 ms apart:** the conditional claim serializes them; exactly one converts. If a
  live lease is present, the second defers instead of converting.
- **Deadline expires:** terminate *and reap* the child before the message becomes visible again.
  Skipping the reap is the original bug — the orphan keeps its ~2 GB while the redelivery converts
  beside it, and that is the exit-137 OOM spiral the team was already seeing.
- **Permanent failure** (exit 2, "required table missing"): fail on the first attempt. Two more tries
  buy nothing and cost tens of minutes of an export slot each.
- **Transient failure** (exit 137): release the lease back to `queued` and call
  `ChangeMessageVisibility(0)` so the retry is available immediately rather than waiting out a
  125-minute visibility timeout. Retry against the stored `attempt`, budget of 3.
- **A slow attempt finishing after a newer one published:** its conditional write loses on `version`
  and is discarded with `job.stale_write_discarded`. Per-attempt keys mean it never touched the good
  bytes in the first place.
- **The worker dies outright:** nothing writes a terminal state, the lease expires, and the
  redelivery claims attempt *n+1*. If the message is gone too, the sweeper Lambda catches leases
  expired beyond any possible in-flight message and fails the job. **The sweeper is what makes "every
  job reaches a terminal state" a guarantee rather than a hope.**
- **Something fails repeatedly:** `maxReceiveCount` 10 sends it to the DLQ, and the sweeper drains the
  DLQ into `failed` so the caller always learns.

**The one line to have ready:** the stored `attempt` is the retry budget; SQS's `receiveCount` is only
a poison-pill backstop. They are different counters because deferrals spend a receive without
spending an attempt — which is exactly why `maxReceiveCount` must sit well above the budget rather
than equal to it.

### How the caller learns

Poll `GET /jobs/{id}`, where the four external states are just the record's `status`; or take a
webhook. The webhook derives from the **committed** DynamoDB transition rather than from worker code,
which removes the failure mode where a worker commits and then dies before notifying. The stream
Lambda does nothing but fan the event into a delivery queue — delivering on the shard itself would let
one customer's failing endpoint block every other customer for the stream's 24-hour retention, which
would be a cross-customer outage introduced by a reliability improvement.

### Close on the operating loop, since that is what they are grading

One CDK app holds every queue, table, task definition, Lambda, and alarm, so an alarm threshold is
reviewed in the same pull request as the code that trips it. GitHub Actions runs typecheck, the test
suite, and a `cdk diff` on the pull request; merge builds one image tagged with the commit SHA,
pushes to ECR, and deploys to staging, where a five-minute canary — one small import, one small
export — must pass before promotion. Production is a rolling deploy of that same digest, one fleet at
a time, imports first because their blast radius is minutes rather than tens of minutes. A bad release
shows up as the canary going red, the transient-failure rate breaching when split by image tag, or
task starts failing. **Stopping and reversing are different levers:** stopping is desired count to
zero on the affected fleet, which is safe precisely because the queue holds the work and costs only
latency; reversing is redeploying the previous task definition revision, made automatic by ECS
deployment alarms on the transient-failure metric. Note why the circuit breaker is not enough on its
own — it only catches tasks that fail to *start*, and a task that starts cleanly and fails every job
never trips it.

**Suggested budget for a 60-minute session:** five minutes on the framing and the flow, ten on the
failure paths, fifteen on operations and observability, fifteen on the code, and leave the rest for
their new evidence. If they let you choose where to go deep, choose observability — that is where the
panel has said it is spending its time.

---

## 1. Cheat sheet

### The design in six sentences

1. Keep the proposal's shape — API Gateway + Lambda, DynamoDB, SQS, ECS Fargate — and change three
   things: split the queue and fleet by kind, size the task to the conversion, and make the worker
   treat at-least-once delivery as at-least-once.
2. Imports and exports get their own queue, DLQ, scaling policy, and task shape, because their
   runtimes differ by two orders of magnitude and a five-second import must not queue behind a
   40-minute export.
3. Slots are derived, not guessed — `min(vCPU, floor((memGiB − 2)/2), floor(diskGiB / peakScratchGiB))`
   — giving imports 2 vCPU / 8 GB / 2 slots and exports the same plus 200 GiB of ephemeral storage
   and 1 slot.
4. DynamoDB is the single source of truth and every transition is one conditional write on a
   `version` attribute, so exactly one worker owns a job at a time and a slow attempt's result is
   discarded rather than published.
5. Results go to per-attempt keys, object first and record second, so the record never advertises
   bytes that do not exist; the caller learns the outcome by polling `GET /jobs/{id}` or from a
   webhook derived from the committed state change via a DynamoDB stream.
6. Every queue, table, bucket, task definition, Lambda, and alarm lives in one CDK app in the same
   repo as the worker, so a threshold is reviewed in the same pull request as the code that trips it.

### The three risks, ranked

1. **The worker fails healthy jobs and strands others in `running`.** A 30-second deadline times out
   every real job, and the timeout path retries without killing the child, so the orphan holds its
   ~2 GB while the redelivery converts beside it — the exit-137 spiral. Customer impact: good work
   returns as a failure indistinguishable from a bad file.
2. **Two workers can own one job, and the slower one's write wins.** Deliveries 100 ms apart both
   read `queued`, both convert, and every `put` is an unconditional write over a stale snapshot.
   Customer impact: the customer downloads a superseded or half-written package.
3. **One queue, one fleet, ten concurrent messages on a 1 vCPU / 4 GB task.** Fivefold memory
   oversubscription, tenfold slowdown on a single core, 40 GB packages against a 20 GiB default disk.
   Customer impact: during onboarding, imports that take seconds take hours.

Left alone deliberately: DynamoDB/API Gateway/Lambda as the control plane, and one worker codebase
for both converters. Each has a stated revisit threshold — have those ready, they are graded.

### The two code fixes

- **Per-kind deadlines that terminate *and reap*** (15 min imports, 120 min exports), replacing the
  30-second `Promise.race` that abandoned the subprocess.
- **Single-writer discipline**: a conditional write on `version` for every transition, a
  `leaseExpiresAt` claim that defers a duplicate delivery, per-attempt result keys, and the stored
  `attempt` as the retry budget instead of `receiveCount`.

### Numbers to have cold

| | |
|---|---|
| **Per slot-hour** | import **$0.058**, export **$0.137** (from $0.04048/vCPU-h, $0.004445/GB-h, $0.000111/GB-h above the included 20 GiB) |
| **Onboarding evening** | 2,400 imports = 120 slot-hours, 600 exports = 300 slot-hours → 120 import slots (**60 tasks**, 1 h drain) + 75 export slots (**75 tasks**, 4 h drain) = **135 tasks, 270 vCPU**, 1.1 TB RAM, ~15 TB scratch, ≈ **$48**. No lag factor here, unlike the monthly line — a four-hour saturated drain packs nearly perfectly, and that asymmetry is deliberate rather than an oversight |
| **Monthly total** | ≈ **$9,600** unmanaged — compute $670 (imports $70, exports $410, ×1.4), S3 **$8,600**, everything else ~$300, which includes the sweeper's naive `Scan` at $122 priced honestly rather than assuming the sparse index |
| **S3 share** | **90%** of the bill; compute is ~7% |
| **Lifecycle rule** | Keyed per kind, because S3 lifecycle prefixes are **literal** and `jobs/*/attempts/*` matches nothing: exports expire at 14 days (**$1,290**), import JSON retained the full 90 days (**$330**) because exports read it as input = **$1,620**. Total ≈ **$2,600**, a **73% cut** |

Two more worth carrying: the NAT counterfactual is **~$13,000/month**, not the ~$5,400 first quoted
(processing is $0.045/GB in *both* directions, plus ~$66/month of gateway hours). And on export task
sizing — a 1 vCPU / 6 GB task is **$0.0871/slot-hour**, $261/month instead of $410, and turns the
evening's 270 vCPU into 195. That one was **deliberately not applied**: the conversion is
single-threaded, but multipart upload, JVM GC, and zip throughput on a 40 GB package are not, so it
is written up as a profiling hypothesis rather than banked as a saving. Concede the reasoning, not
the number.

### Hold these lines — the obvious objections that are wrong

Every one of these has been independently verified. Do not concede them to a confident reviewer.

| If the panel says | You say |
|---|---|
| "200 GiB of ephemeral storage isn't a thing on Fargate" | It is. 20 GiB default, 21–200 GiB configurable, platform version 1.4.0+, billed on the increment above 20 GB. |
| "Just raise `stopTimeout` so exports drain gracefully" | Fargate caps `stopTimeout` at 120 seconds (range 2–120, default 30). A 40-minute export *cannot* drain, which is exactly why scale-in protection carries the design. |
| "A 125-minute visibility timeout is illegal / absurd" | The cap is 12 hours from `ReceiveMessage`, so 125 minutes is comfortably inside it. The 60-second `ChangeMessageVisibility` heartbeat is literally AWS's documented recommendation for unknown processing times. |
| "Task protection only stops scale-in, a deploy will still kill your export" | `UpdateTaskProtection` protects against deployments *and* Service Auto Scaling scale-in, with `expiresInMinutes` from 1 to 2,880. A 120-minute export fits. |
| "Your lease is a wall clock, so two workers could publish conflicting results" | No. See Q3 — the `version` conditional fences every write; skew costs money, not correctness. |
| "SQS can't hold 14 days of backlog" | 14 days is the maximum (60 s–1,209,600 s). The only correction needed is that the *default* is 4 days, so the attribute must be set explicitly. |
| "A DynamoDB stream can't drive webhooks" | The mechanism is fine; filter criteria on `newImage.status` are supported. The problems are retention, retry bounds, and DLQ payload — see Q11. |
| "Your compute estimate must be wrong, Fargate is expensive" | Compute is ~7% of the bill and S3 is ~90%. Every figure in §5 reproduces from unit prices. |

---

## 2. Twenty questions the panel is likely to ask

Questions 2 through 11 cover findings that are **fixed in the submission you sent**. They are still
the sharpest available attacks on the draft, a reviewer may be reading an earlier copy, and "here is
what I found on re-read and how I fixed it" is a stronger answer than "that isn't in there." Know
the failure mechanism, not just the fix.

**Q1. Why did you rank the deadline bug above the duplicate-result bug? Integrity beats availability.**
At a 30-second deadline the service has an approximately **0% success rate on real work** — imports
take minutes, exports take tens of minutes. There is no functioning system for the duplicate-result
bug to corrupt. Fixing the deadline is not "the more frequent bug," it is the difference between a
service and no service. Both were fixed in the same change anyway, so the ranking is a narrative
question, not a scope one.
*Concede:* if the deadline were correct, duplicate results would rank first — a wrong package in a
customer's hands is worse than a failed job.

**Q2. You told me `receiveCount` is the wrong retry counter. Why is your redrive policy still `maxReceiveCount` 3?**
It isn't any more — it's well above `maxAttempts` (10–20), with the stored `attempt` as the only
budget and the redrive policy demoted to the poison-pill backstop the code already calls it. At 3 the
two budgets align with zero slack: every deferral — `job.lease_held`, `job.claim_conflict`, and the
transient release — returns the message without consuming an attempt, so one duplicate delivery cuts
the real budget to 2 and two duplicates cut it to 1. Worse, a redriven message leaves the record
`queued` with *no lease*, which the sweeper's predicate cannot see, so the DLQ drain marks a
retryable job `failed`.
*Concede:* I fixed the counter in the code and left it in the infrastructure. It is a
code-plus-config interaction and neither half is wrong alone, which is exactly why I missed it.

**Q3. Your lease is a wall-clock timestamp on a fleet of machines. Two workers could publish conflicting results.**
They cannot. The lease is an optimization that avoids duplicate work; the safety property is the
`version` conditional on every write. Uniform skew is harmless — the lease is compared against the
same offset that wrote it. Mixed skew is the interesting case: a lagging worker writes a lease that
correctly-clocked workers read as expired, so a duplicate claims attempt 2 and converts the same
package concurrently — but the first worker's write loses its condition, is discarded as
`job.stale_write_discarded`, and the job ends `succeeded` at the correct attempt.
*Concede, and volunteer it:* the honest cost of skew is **duplicate work** — two concurrent 2 GB
conversions and two 100 GiB scratch allocations on a fleet sized for one — and an **inflated
`attempt`**, which shortens the real retry budget and compounds Q2. Not incorrect state.

**Q4. Walk me through the lifecycle rule. `jobs/*/attempts/*`.**
That prefix matches nothing — S3 lifecycle filters take a literal prefix and `*` is a literal
character, so the rule carrying my entire cost conclusion was unexpressible. It is now keyed by kind:
`exports/` expires at 14 days, `imports/` is retained the full 90, plus an
`AbortIncompleteMultipartUpload` rule, because 10–40 GB multipart uploads with attempt-level retries
leave orphaned parts that are billed and that an expiration rule never touches. The original scoping
also would have deleted import JSON, which is the *input* to exports — it breaks future exports, not
just downloads.
*Concede:* the fix costs roughly $290/month ($1,620 rather than the ~$1,330 the broken rule implied)
and takes the headline from a 78% cut to **73%**. Cheap price for removing a whole failure class and
a policy argument — and the 78% was never real, since the rule it rested on did nothing.

**Q5. Your `JobStore.put` is documented as an `UpdateItem` but the signature takes a whole `Job`. Which is it?**
`UpdateItem` with `ConditionExpression: version = :expected`, `SET` for the attributes the handler
owns, and an explicit `REMOVE leaseExpiresAt` on release. A whole-item replace destroys the
idempotency-key attribute projected into the GSI and the 90-day TTL attribute on the first claim —
idempotent re-submission stops working and job metadata never expires. It also can't be literal,
since `ReturnValues: ALL_NEW` is not valid for `PutItem`. And if you read it as `SET`-only without
the `REMOVE`, the released job keeps a stale lease and every redelivery defers for up to 121 minutes.
*Concede:* the in-memory fake replaces the whole item, so the test asserting `leaseExpiresAt` is
`undefined` after a terminal write passes for the wrong reason. A green suite over ambiguous adapter
semantics is the worst shape to be caught in; the fake needs to merge, not replace.

**Q6. Where are the consistency holes in your control plane?**
Three. `GetItem` is eventually consistent by default, so the worker's pre-claim read needs
`ConsistentRead: true` or it reads a stale version, loses its conditional claim, and defers for no
reason — the API's `GET /jobs/{id}` can stay eventually consistent, the worker's read cannot. Second,
pre-existing rows have no `version` attribute, so `version = :expected` fails against them forever
and those jobs can never be claimed; the migration is
`attribute_not_exists(version) OR version = :expected` for a window, with the adapter defaulting a
missing version to 0. Third, **GSI queries are never strongly consistent**, so the idempotency check
is racy by construction — two concurrent submissions with the same key can both miss the index and
create two jobs. The robust form is a conditional `PutItem` on an item keyed by the idempotency key,
or folding the key into the primary key.
*Concede:* the exercise is "evolving a service under real production load," so rows without a
`version` are the default case, not an edge case, and nothing in the tests covered it.

**Q7. What happens if the terminal write to DynamoDB throws?**
There is a `try`/`catch` around the handler body now, plus a bounded retry on the terminal write
specifically. Without it the throw escapes `handle()` into the poll loop: the message is never acked,
the job stays `running` with a live 121-minute lease, every redelivery takes the `lease_held` branch
and burns a receive, and the sweeper cannot act until the lease expires. One DynamoDB throttle after
a completed 30-minute export costs the result, a full re-run, and a two-hour customer wait.
*Concede:* my notes filed this as a cost problem. It is a two-hour customer-visible stall, and any
throw from `store.get`, `message.ack`, or the kill path escaped the same way.

**Q8. Your fleet scales from zero. Show me the scaling metric at zero running tasks.**
`ApproximateNumberOfMessagesVisible / RunningTaskCount` is a division by zero at zero tasks, which
produces no data point, and target tracking explicitly does not scale on insufficient data — so the
fleet never leaves zero, on the onboarding evening. It uses AWS's published form now:
`IF(m2==0, IF(m1>0, 1000000, 0), m1/m2)`. Two neighbours: `RunningTaskCount` is a Container Insights
metric that has to be enabled and is separately billed, and `Visible` excludes in-flight messages, so
it collapses to zero while 40-minute exports are still running and the policy immediately asks for
scale-in — which is what the task protection is for.
*Concede:* the entire cost model assumes scale-from-zero and the metric as written could not do it.

**Q9. You gave me three signals. What's missing?**
The two the architecture actually lives on. **DLQ depth** —
`ApproximateNumberOfMessagesVisible > 0` per DLQ is the highest-signal alarm available in a queue
system and it is where every unrecoverable job lands. **Sweeper and webhook health** — the sweeper is
what makes "every job reaches a terminal state" true, and if it dies nothing notices and the
guarantee silently evaporates, so it needs `Errors`, `Duration`, and an `Invocations == 0` dead-man's
alarm; the webhook event source mapping needs `IteratorAge`, the only metric that reveals backlog
before DynamoDB Streams' 24-hour retention destroys the records. Two more that are nearly free: the
canary needs `TreatMissingData: breaching` — if the canary stops being submitted, *that is the
outage* — and a daily `BucketSizeBytes` alarm, given that 92% of the bill is S3 and one wrong
lifecycle rule multiplies it 4.5×.
*Concede:* the three I picked are the right three, but my "fourth signal" slot spent itself on a
gauge the sweeper emits without ever monitoring the sweeper.

**Q10. You put `jobId` on every EMF line as a dimension. What does that cost?**
In EMF, every unique dimension set creates a separate billable custom metric at roughly $0.30 per
metric-month, and the spec warns explicitly against `requestId`-shaped dimensions. `jobId` is about
1,000 new custom metrics per day; `attempt` and image tag multiply the set on every deploy and never
shrink. They are **properties** now — in the log line, queryable in Logs Insights, free — with `kind`
and `classification` as the only dimensions. That distinction is the difference between the $25/month
I budgeted and several hundred.
*Concede:* two neighbours in the same line item were also wrong. Log retention was never set
(CloudWatch Logs defaults to never expire), and the vendor JVM's stdout across a 40-minute export at
~50 MB per export is 300 GB/month, ~$150 of ingest — the most likely 5× miss in the whole bill.

**Q11. One customer's webhook endpoint is down. What happens to everyone else's?**
As drafted: they stop. The event source mapping's default `MaximumRetryAttempts` is `-1`, meaning
infinite, and a table this small has very few stream shards, so one endpoint returning 500s blocks
its shard for up to the full 24 hours of stream retention. That is a cross-customer, head-of-line
outage introduced by a change made to *improve* reliability. "Its own DLQ" also doesn't mean what it
sounds like — an SQS or SNS on-failure destination for a Streams mapping receives invocation metadata
only, shard id and sequence numbers, not the record, and you're expected to re-read the stream, which
is gone at 24 hours. An **S3** on-failure destination carries the full payload. The fix is structural:
the stream Lambda does nothing but fan the terminal transition into a delivery queue, plus bounded
retries, `bisectBatchOnFunctionError`, and an S3 destination.
*Hold the line on the mechanism:* deriving the notification from the committed state change is the
right call and removes the "worker commits, then dies before notifying" window. The gap was the
delivery path, not the trigger.

**Q12. An export fails transiently after five seconds. When does attempt 2 start?**
Today, over two hours later — and it pages on-call. `retry()` takes no delay, so the message cannot
reappear before the queue's visibility timeout, which is 125 minutes for exports so it can cover the
120-minute deadline. Three attempts can span more than six hours of wall clock even when every
attempt fails instantly. And `ApproximateAgeOfOldestMessage` counts received-but-not-deleted
messages, so **one ordinary transient export retry reliably trips my own 60-minute export alarm**. The
fix is `ChangeMessageVisibility` on the release path — near zero for a released retry, and
`remainingLease` for a deferred duplicate, which are opposite directions.
*Concede:* my notes have the right primitive but file it as a cost optimisation and aim it only at
deferring duplicates later. It is misranked in my own list; this is the first thing I'd move up.

**Q13. How do you know a release is bad before customers do, and how do you stop it?**
Three detection layers: the canary — one small import and one small export every five minutes in
every environment, with missing data treated as breaching — catches a control-plane break even when
there's no traffic; `job.failed{classification=transient}` dimensioned by image tag catches a release
that starts cleanly and fails every job; ECS task-start failures catch one that can't boot. The stop
lever is **set desired count to zero**, or stop polling, which is safe precisely because the queue
holds the work — without it a bad release burns the attempt budget on 3,000 messages while you
diagnose. Reversal is redeploying the previous task definition revision.
*Concede:* the draft answered "reverse" well and never named a stop lever. Free upgrade I'd take:
ECS **deployment alarms** (`deploymentConfiguration.alarms`, rolling updates, with a bake time) turn
the existing by-image-tag signal into automatic rollback — the deployment circuit breaker alone only
catches tasks that fail to *start*. And export deploys can take up to two hours waiting behind
protected tasks; that's a stated operational property, not a surprise for an incident.

**Q14. Why not Step Functions?**
Step Functions earns its keep when there are multiple steps with branching, waits, human approval, or
heterogeneous compute per step. This is one step: claim, convert, publish. A state machine would put
a second source of truth for job state next to DynamoDB, and the genuinely hard problems here —
duplicate delivery, single-writer ownership, per-attempt result keys, two-hour deadlines — are
identical either way. It relocates them rather than solving them. Cost isn't the argument at 1,000
jobs/day. Revisit when the pipeline gains a real second step — virus scan, schema validation,
customer approval — or needs fan-out/fan-in within a job.
*Concede:* I'd get execution history and a visual per-job timeline for free, and I'm paying for both
with EMF and a hand-built dashboard.

**Q15. Why not AWS Batch, or plain EC2 with an Auto Scaling group?**
Batch is the closest fit on paper — it *is* queue-plus-fleet for long, bursty, non-interactive work,
and it would own scheduling and retry. Three reasons I didn't: the team already runs ECS, Batch on
Fargate inherits the same vCPU quota and 200 GiB disk ceiling so it solves neither binding
constraint, and Batch's job-level retry would be a second retry authority competing with the stored
`attempt` — the exact class of bug I just spent the code half of this exercise removing. EC2 wins on
price per vCPU, more so with Spot, and instance store would end the ephemeral-storage line entirely,
but you take on AMI patching, capacity rebalancing, and instance draining.
*Concede:* if compute were the largest line item, EC2 or Spot would be the answer. At $670 against a
$9,600 bill, that operational surface buys 7% of the wrong number. Revisit at 10x.

**Q16. Why not Lambda for imports? They're 80% of volume and take seconds to minutes.**
It's the most tempting alternative on the page. Three things stop it: the 15-minute execution cap
against an import described as "seconds to several minutes" with no stated upper bound — the tail is
exactly where it breaks, and I'd be trading a bounded retry for a hard kill; 10 GB of memory and
10 GB of `/tmp` against a 2 GB input producing up to 500 MB of JSON, which fits but with thin
headroom; and two code paths, two deployment stories, and two observability shapes for one converter
library. Cost isn't the argument either way — import compute is $70/month.
*Concede:* with measured p99 well under 15 minutes, Lambda is probably right — it kills scale-from-zero
lag, which is the 1.4× factor in my own cost model, and it removes half the fleet from the quota
problem. It's my strongest "if I had more time" item on the compute side.

**Q17. Conversions are single-threaded. Why does a 1-slot export task get 2 vCPU?**
Honest answer: for the conversion itself it doesn't need it. The defensible reasons are the work
*around* the conversion — multipart upload threads pushing a 40 GB zip, JVM GC threads, and
compression throughput — but the design doesn't state them, so it reads as unexamined rather than
deliberate. 1 vCPU / 6 GB is $0.0871 per slot-hour against $0.1365: 43% off the export compute line,
$261/month instead of $410, and the evening drops from 270 vCPU to 195, which matters because the
quota is the binding constraint, not the money. The structurally better answer is to stream the
vendor's zip to S3 via multipart instead of staging it on disk — that roughly halves peak scratch,
makes 2 slots genuinely fit, and halves the per-package compute.
*Concede:* while we're here, my slot formula returns `floor(200/100) = 2` for exports and the text
says 1. The text is operationally right — two 100 GiB exports on 200 GiB leaves nothing for image
layers — but the formula needs a headroom term or it's arithmetic I didn't check.

**Q18. Why aren't exports resumable? A failure at minute 39 of 40 costs the whole run.**
Resumability requires checkpointing inside the vendor JVM, and the exercise says I may wrap it but
not change it. The one thing I could do — persist staged media across attempts — trades the property
I most want after an OOM, a clean slate, for the thing I least need: 30 minutes of compute at
$0.137 per slot-hour, roughly seven cents per failed export. The real cost of a restart is customer
latency, not money.
*Concede:* it's the weakest part of the export story and it gets worse as packages grow. Revisit when
export p99 approaches the 120-minute deadline, or when the transient export failure rate is high
enough that expected time-to-success meaningfully exceeds one clean run.

**Q19. What breaks at 10x volume?**
In order. **Quota and IP space** — already the binding constraint during a 1x onboarding evening; at
10x it's the steady state, so the vCPU limit increase and /22 subnets stop being a lead-time item and
become a capacity plan. **S3** — $8,600 becomes ~$86,000 if retention doesn't change, so the
lifecycle rule stops being an optimization and becomes the architecture. **The sweeper** — a
per-minute `Scan` over 90 days of items is already ~$122/month at 1x, twelve times my entire
control-plane line, and it grows with both retention and volume; it needs a sparse GSI over
non-terminal jobs keyed by `leaseExpiresAt`. **The webhook path** — ten times the terminal
transitions through very few shards and one head-of-line blocking point. What doesn't break: the
queues, the claim/lease protocol, and DynamoDB on-demand.
*Concede:* at 10x the compute substrate is the first thing I'd change, because compute stops being 7%
of the bill — that's where EC2/Spot and Lambda-for-imports come back.

**Q20. The budget is halved. What do you cut?**
There is exactly one lever that gets from $9,600 to $4,800, and it's retention. Per-kind lifecycle
expiry takes S3 from $8,600 to ~$1,620 and the total to ~$2,600 — below half on its own — and nothing
else on the page is a rounding error against it. After that, in order: the export task from 2 vCPU to
1 ($410 → $261), and pruning interface endpoints, since DynamoDB's gateway endpoint is free and ~$60
of interface endpoints is most of the import compute line. What I would not cut: PITR, the canary, or
the DLQ and sweeper alarms — they are a few dollars each and they are the difference between a system
that fails visibly and one that fails silently.
*Concede:* "halve the bill" here is a policy conversation about retention, not an engineering
exercise. The interesting question is whether 14 days is acceptable to customers — that assumption is
what my entire cost conclusion rests on, and if it's wrong the ranking changes, not the arithmetic.

---

## 3. New evidence mid-session: how the design bends

The pattern for all of these: name the existing primitive that absorbs it, name the number that
moves, and name the threshold you'd already written down. The design is supposed to bend here.

**"The vendor JVM leaks — RSS climbs across jobs in the same task."**
Slots are already the unit of isolation and the subprocess is already killed and reaped per job, so
this doesn't corrupt anything. What it needs is a task-level recycle: drain and replace a task after
N conversions, using the same task-protection and desired-count machinery the deploy path already
uses. Because the queue holds the work and a recycled task's in-flight job is redelivered with an
expired lease, recycling is free. The trap is that exit 137 is classified transient, so a leak looks
exactly like a flake — the tell is 137s correlating with **task age** rather than with input, which
is why ECS stop reasons grouped by `OutOfMemoryError` is on the dashboard. And the formula's 2 GB
runtime reserve is no longer enough, so slots get re-derived; that's what the formula is for.

**"We measured p99 import runtime at 22 minutes, not 3."**
The 15-minute deadline is now below p99, which means it is manufacturing failures — the exact bug I
ranked first. Deadlines were sized to bound a hang, not to enforce an SLO, so they move: import
deadline above measured p99 with headroom, import visibility timeout to match. The numbers that move
are the cost model's import compute line ($70 → roughly $500, still under 6% of the bill) and the
evening's 120 import slot-hours, which becomes ~880 — at which point the one-hour drain target is
infeasible against the quota, so the *drain target* changes, not the architecture. The signal that
would have caught this before a customer did is already in the design: `job.deadline_exceeded` above
~1/hour per kind, which is precisely an alarm on "the deadline no longer matches reality."

**"Duplicate delivery isn't rare. We see it on 30% of messages."**
The claim/lease protocol is unchanged and correct — that's what it's for, and `job.lease_held` and
`job.claim_conflict` are already instrumented, so this evidence would appear on the existing
dashboard rather than as a surprise. What it breaks is the *budget*: at 30% duplication the collision
between `maxReceiveCount` and the attempt budget goes from a latent bug to a daily one, which is why
the redrive count must be far above `maxAttempts`. It also makes `ChangeMessageVisibility(remainingLease)`
on the deferral path a real cost item rather than a nicety, because every deferred duplicate is
currently churning the queue for a full visibility timeout.

**"Your vCPU quota increase is still pending the night of the first onboarding."**
This is the constraint the design already names first, and the backlog-age runbook opens with it.
Without the quota the evening becomes a longer drain, not a failure, because the queue holds the work
and `MessageRetentionPeriod` is set explicitly to 14 days — the customer-visible effect is latency on
onboarding imports, which is the least bad place to absorb it. The lever I'd actually pull is task
shape: 1 vCPU / 6 GB exports turn 270 vCPU into 195, which may fit under a limit that 270 doesn't.

**"A customer requires seven-year retention on packages."** / **"10% of packages are being pulled over the internet."**
Neither touches the architecture; both invert the cost conclusion, which is the honest thing to say
out loud. Seven-year retention means per-customer prefixes with per-prefix lifecycle rules and
Glacier Deep Archive for the long tail, priced back to that customer — what you must not do is raise
the default for everyone. Internet egress at 10% is ~12 TB/month, $600–1,100, at which point
CloudFront or writing directly to a customer-supplied destination bucket becomes the next
optimization ahead of the lifecycle rule. Both were stated as explicit assumptions in the appendix,
which is the point of stating them.

**"Callers now want to cancel a running job."**
The primitives already exist: a conditional write recording cancellation intent, which the worker
observes at its next heartbeat and turns into the kill-and-reap path that's already built and tested.
The message is acked, the record is terminal, and the sweeper covers the case where the worker never
sees it. The real cost isn't mechanical — it's a fifth externally visible state where the spec says
there are four, so it's a product conversation before it's an engineering one.

**"We need a second region."**
The posture is already rebuild-and-replay with the CDK app as the only source of truth, and RPO is
~5 minutes from PITR. The prerequisites are the ones people forget: ECR is regional, so the image
needs cross-region replication before the stack is any use; PITR restores into a *new* table, so the
runbook needs a swap step; and the long pole is the Fargate quota in the destination region, which is
why I'd pre-raise it in one paired region. That's a runbook and two prerequisites, not a redesign.

---

## 4. Honest soft spots, and the best answer available

These have no clean answer. Lead with the admission, then the mitigation, then the threshold.

- **No heartbeat.** The lease is correct but the queue churns, and the 125-minute visibility timeout
  is doing the job a heartbeat should. It's the number one not-done item, and it's upstream of the
  retry-latency problem in Q12. *Best answer:* the design is correct without it and merely wasteful;
  I'd build it first, and it's roughly a day of work against the existing `Deadline` seam.

- **The sweeper is designed, not written — and it's what makes the terminal-state guarantee true.**
  Its predicate as stated isn't implementable: SQS exposes no per-message in-flight query and
  `ApproximateNumberOfMessagesNotVisible` is queue-wide. *Best answer:* the implementable version is
  time-based — store a `visibleAfter` on the record, or require `lease + max visibility timeout` to
  have elapsed — and it must also catch records parked in `queued` with no lease. Its access pattern
  is also missing from my justification for leaving DynamoDB alone: a per-minute `Scan` is ~$122/month
  against a $10 control-plane line, so it needs a sparse GSI on `leaseExpiresAt`, not a scan.

- **The classification table has one real entry.** Exit 2 is permanent, everything else retries, and
  `classifyFailure` treats a missing or non-numeric exit code as transient — so a wrapper bug that
  loses the exit code silently converts every permanent failure into three attempts. *Best answer:*
  transient is the deliberately safe default, since failing a valid job is worse than retrying a bad
  one, but "unknown exit code" needs its own counter so it can't hide, and the table should be grown
  from DLQ samples rather than guessed.

- **One attempt budget for two kinds of failure.** Converter failures and platform deaths share the
  budget of three, so three unlucky task recycles fail a valid export. *Best answer:* acknowledged in
  the notes; separate counters is the fix and it's small.

- **The tests prove less than they look like they prove.** The legacy characterization tests pin a
  frozen copy of the original handler, so they're executable documentation rather than regression
  protection. The "survives a late subprocess rejection" test asserts only the *absence* of an
  unhandled rejection with no positive control that the rejection happened. The "discards a slow
  attempt's result" test simulates the competing writer with a direct `store.put` rather than a second
  `handle()`. Untested: a rejecting `store.put`, attribute preservation across a `put`, the
  release-plus-redelivery interaction, clock skew, and the shipped `leaseGraceMs` — which is 2 minutes
  in `src/index.ts` and 1 minute in the fakes, so the shipped value is never exercised. *Best answer:*
  name the gaps before they're found; the mechanism (running the old handler against the same fakes)
  is still better than asserting "these would have failed before."

- **The NAT counterfactual is understated by ~2.4×, in my favour.** Data processing is $0.045/GB in
  *both* directions and an export both reads ~20 GB and writes ~20 GB, so it's ~$13,000/month, not
  ~$5,400 — and I omitted NAT hours entirely, ~$66/month for two AZs, which you pay even with the
  gateway endpoint in place. *Best answer:* volunteer it. Being wrong in your own favour on the
  headline number of your conclusion is worse than the number being bigger.

- **The endpoint list is incomplete.** SQS also needs an interface endpoint if tasks have no NAT
  route, ECR needs both `ecr.api` and `ecr.dkr`, and DynamoDB has a free gateway endpoint I never
  mentioned. ~5 endpoints × 2 AZ ≈ $73, so the $60 is the right magnitude. *Best answer:* also note
  that the design implicitly pays for both NAT and interface endpoints, which are near-substitutes at
  this traffic level — that's a choice I should have made explicitly.

- **Two deliberate asymmetries, so own them as choices rather than get caught.** The evening's $48
  applies no lag factor while the monthly bill applies 1.4×: that is intentional, because the factor
  models the idle tail across a month of bursty low volume and a four-hour saturated drain packs
  nearly perfectly. And S3 is priced flat rather than tiered — tiering gives $8,287 against $8,611 at
  374 TB, 4% that changes no conclusion, and the flat rate is easier for a reviewer to audit. Say
  both out loud as decisions; a reviewer who prices S3 daily will notice the second one. SQS
  `MessageRetentionPeriod` defaults to 4 days, so "the queue absorbs 14 days" requires setting the
  attribute. DynamoDB TTL deletion can lag up to 48 hours, which is fine as a retention floor and
  wrong as a compliance ceiling.

- **The one-hour import drain target was never examined.** Slot-hours are conserved, so draining 2,400
  imports in 15 minutes costs the same ~$7 and only pushes harder on the quota. Making a three-minute
  job wait an hour is a 20× latency amplification that buys nothing. *Best answer:* good "if I had
  more time" material — the target was inherited from nothing.

- **Export deploys can take up to two hours.** Rolling updates wait behind task-protected exports, and
  CloudFormation or CodeDeploy updates can time out doing it. Protection also defaults to 120 minutes
  and must be renewed, is acquired from inside the container via
  `$ECS_AGENT_URI/task-protection/v1/state` rather than the ECS API, and must be taken *before* the
  receive or there's a window where a task that just claimed work is eligible for termination. *Best
  answer:* state it as a sized operational property up front. "Imports deploy first because their
  blast radius is minutes" is otherwise an admission that export deploys kill work.

---

## 5. Three things to say unprompted

If the room is quiet or you're asked "what would you change," lead with these — they're the strongest
available evidence that you reasoned end to end rather than section by section.

1. **The `maxReceiveCount` / attempt-budget collision.** "I fixed the retry counter in the code and
   left it in the infrastructure." Volunteering a code-plus-config interaction that neither review
   pass would catch alone is worth more than defending it.
2. **The retry-latency floor is misranked in my own not-done list.** I filed
   `ChangeMessageVisibility` as a cost optimisation and pointed it the wrong way; it's a correctness-
   adjacent issue that trips my own export alarm on an ordinary retry.
3. **The cost conclusion rests on one assumption, not on the arithmetic.** Every number reproduces,
   but the 73% cut is only available if 14-day retention on derived packages is acceptable to
   customers. If it isn't, the ranking changes and the next lever is egress, not compute.
