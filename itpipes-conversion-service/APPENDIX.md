# Appendix to DESIGN.md

Supporting detail for [DESIGN.md](./DESIGN.md). Nothing here is required to follow the argument; it is here so the conclusions can be audited.

## A. Cost derivation

**Rates (us-east-1, on-demand Fargate, Linux/X86):** $0.04048 per vCPU-hour, $0.004445 per GB-hour, $0.000111 per GB-hour of ephemeral storage above the included 20 GiB. S3 Standard $0.023/GB-month, PUT $0.005/1,000. These move; the ratios that drive the conclusion do not.

| Task shape | Hourly | Slots | Per slot-hour |
|---|---|---|---|
| Import: 2 vCPU / 8 GB | 2 × 0.04048 + 8 × 0.004445 = **$0.1165** | 2 | **$0.0583** |
| Export: 2 vCPU / 8 GB + 200 GiB | 0.1165 + 180 × 0.000111 = **$0.1365** | 1 | **$0.1365** |

**Monthly, at 800 imports + 200 exports per day, 30-day month:**

| Line item | Arithmetic | Monthly |
|---|---|---|
| Import compute | 800 × 3 min × 30 = 1,200 slot-hours × $0.0583 | $70 |
| Export compute | 200 × 30 min × 30 = 3,000 slot-hours × $0.1365 | $410 |
| Utilization factor | × 1.4 for scale-from-zero lag and the idle tail before scale-in | $670 total |
| S3, exports (14-day expiry) | 200 × 20 GB × 30 = 120 TB/month × 14/30 ≈ 56 TB × $0.023 | **$1,290** |
| S3, imports (90-day retention) | 800 × 0.2 GB × 30 = 4.8 TB/month × 3 months ≈ 14.4 TB × $0.023 | **$330** |
| S3 requests | 6,000 exports × ~200 multipart parts = 1.2M PUT × $0.005/1,000 | $6 |
| DynamoDB | ~180k writes, ~600k reads, plus the sweeper's minute-by-minute pass | $1–123 (see §F) |
| SQS | ~3M requests × $0.40/M, including long-poll receives | $5 |
| API Gateway (HTTP API) + Lambda | ~630k requests, plus the sweeper and webhook functions | $3 |
| CloudWatch | EMF metrics on two dimensions, logs with retention set, ~12 alarms | $60 |
| VPC interface endpoints | ECR api + dkr, logs, STS, SQS × 2 AZ × $0.0104/hr × 730 | $73 |
| **Total** | | **≈ $2,600** |

Without the lifecycle rules, S3 holds ~375 TB in steady state (~$8,600) and the total is **≈ $9,600/month, 90% of it S3** — which is the number the 14-day export expiry removes.

**Three storage details that are easy to get wrong and expensive to miss.**

- *Lifecycle filters take literal prefixes.* `Filter.Prefix` does no globbing: `jobs/*/attempts/*` matches zero objects, so a rule written that way is a no-op that quietly costs $7,000/month. That is why results are keyed `exports/{id}/…` and `imports/{id}/…` — the key layout exists to make the rule expressible.
- *Import JSON is an input, not just a result.* Exports read the JSON a previous import produced, so expiring it at 14 days would break future exports rather than merely making a download unavailable, and it would undercut the claim that results are regenerable from customer-owned inputs. Imports keep the full 90 days for $330.
- *`AbortIncompleteMultipartUpload` is a separate action.* A 10–40 GB package uploaded in parts, on a job with attempt-level retries, leaves orphaned parts that are billed as storage and that no expiration rule touches, because they are not objects yet. Seven days is generous and costs nothing.

**Two sensitivities that matter more than the precision above.**

- *NAT gateway.* Data processing is $0.045/GB **in both directions**, and an export reads ~20 GB of JSON and media and writes ~20 GB of zip: ~240 TB/month of export traffic plus imports, or **~$13,000/month**, twenty times the compute bill. A gateway VPC endpoint for S3 costs nothing and removes the line entirely; DynamoDB has a free gateway endpoint too. With interface endpoints for ECR, logs, STS, and SQS, the design needs no NAT gateway at all, which also avoids the $32.85/month-per-gateway hourly charge that survives even when the data path does not.
- *Egress.* The estimate assumes consumers read packages in-region (callers are other ITpipes backend services), so internet egress is zero. If 10% of packages are downloaded over the internet, that is ~12 TB/month at $0.05–0.09/GB, or **$600–1,100/month** — at which point CloudFront or a customer-supplied destination bucket becomes the next optimization instead of the lifecycle rule.

## B. Slot formula derivation

`slots = min(vCPU, floor((memGiB − 2) / 2), floor(0.8 × diskGiB / peakScratchGiB))`

A conversion is single-threaded and wants ~2 GB, so a slot costs one core and 2 GB. The memory term reserves 2 GB for the runtime, the JVM's non-heap overhead, and transfer buffers, then divides the rest. The proposed 1 vCPU / 4 GB with 10 concurrent messages violates both of the first two terms at once: 20 GB of demand against 4 GB, and ten runnable threads against one core.

The 0.8 in the disk term is headroom for image layers and the container filesystem, and it is what makes the formula agree with its own answer: a 40 GB package needs roughly 100 GiB of scratch while media is staged and zipped, so a bare `floor(200/100)` would say two exports fit on a 200 GiB task when in practice that leaves nothing for anything else. With headroom it returns 1. Fargate's default is 20 GiB, which does not fit a single package; 200 GiB is the maximum and is set per task definition.

A 1-slot export task also has no obvious use for 2 vCPU, and 1 vCPU / 6 GB would cut export compute from $410 to $261/month. I am keeping 2 vCPU deliberately, for multipart upload threads, JVM GC threads, and zip throughput on a 40 GB package — but that is a hypothesis about the vendor binary, and the first profiling run either confirms it or saves 43% of the export compute line and drops the onboarding peak from 270 vCPU to 195, which matters because the quota is the binding constraint.

## C. Capacity planning for the onboarding evening

3,000 jobs = 2,400 imports + 600 exports. Import work: 2,400 × 3 min = 7,200 slot-minutes = 120 slot-hours. Export work: 600 × 30 min = 18,000 slot-minutes = 300 slot-hours.

| Target | Slots | Tasks | vCPU | Memory | Ephemeral disk |
|---|---|---|---|---|---|
| Imports drained in 1 hour | 120 | 60 | 120 | 480 GB | default |
| Exports drained in 4 hours | 75 | 75 | 150 | 600 GB | 15 TB |
| **Peak** | | **135** | **270** | **1.1 TB** | **15 TB** |

Cost for the evening: 60 × 1 h × $0.1165 + 75 × 4 h × $0.1365 ≈ **$48**. Money is not the constraint; five operational limits are.

1. **Fargate On-Demand vCPU quota.** The account default is 6, against 270 needed. A quota increase is a lead-time item and must be requested before the first onboarding, not during it. If it is not raised the fleet simply stops scaling, and the only symptom is the backlog-age alarm — which is why that alarm's runbook names the quota first. Task *launch rate* is not a constraint: the region sustains 20 launches per second.
2. **IP space.** `awsvpc` gives each task an ENI, so 135 tasks need 135 addresses. A /24 (251 usable) survives one evening and not two concurrent ones; the worker subnets should be /22.
3. **The scale-out metric must survive zero tasks.** Target tracking on `ApproximateNumberOfMessagesVisible / RunningTaskCount` divides by zero when the fleet is scaled to zero, publishes no datapoint, and ECS explicitly does not scale on a metric with insufficient data — so the fleet never leaves zero on the evening the whole design is sized for. The guarded form is AWS's own: `IF(m2 == 0, IF(m1 > 0, 1000000, 0), m1 / m2)`. Two related notes: `RunningTaskCount` comes from Container Insights, which is separately enabled and billed; and `MessagesVisible` excludes in-flight messages, so it collapses once a burst is picked up, which is one more reason scale-in protection is not optional.
4. **Image pull.** 135 tasks pulling a ~1 GB image inside ten minutes is ~135 GB through the ECR endpoints, on the critical path of every scale-out. Keep the image small and use SOCI lazy loading if task start drifts above ~90 seconds.
5. **Scale-in during long work.** A task holding a 40-minute export must not be chosen for termination, which is what `UpdateTaskProtection` is for. It protects against deployments as well as scale-in, it is acquired from inside the container via `$ECS_AGENT_URI/task-protection/v1/state` rather than the ECS API, it must be taken *before* the receive rather than after, and it must be renewed: the default 120 minutes expires at roughly the same moment as a 120-minute export deadline. The cost is that a rolling deploy of the export fleet waits for protected tasks, and CDK or CodeDeploy can time out waiting, so "export deploys can take two hours" is a stated property, not a surprise.

## D. Failure scenarios

| Failure | How it is detected | Behaviour | Recovery |
|---|---|---|---|
| Worker task killed mid-conversion | Backlog age; `job.lease_held` on redelivery | Message redelivered after the visibility timeout; the lease has expired | Attempt `n+1` starts clean. Cost: one wasted attempt. |
| Converter hangs | `job.deadline_exceeded` | Deadline fires, child terminated and reaped, attempt released to `queued` | Retried within the attempt budget |
| Converter exits 2 | `job.failed{classification=permanent}` | Terminal on the first attempt, no retry | None needed; the input is bad. Weekly report, not a page. |
| Converter exits 137 (OOM) | `job.failed{classification=transient}`, ECS `OutOfMemoryError` stop reason | Transient retry | If it repeats, it is a sizing bug, not a flake — re-derive slots with §B |
| Converter fails with no exit code | `job.unclassified_failure` | One retry, then terminal | Treat as a wrapper regression; the counter is the whole point |
| Duplicate delivery | `job.lease_held`, `job.claim_conflict` | Live lease defers the message for the lease remainder; a stale write loses its condition | Automatic. The counters exist so it does not stay invisible |
| Any seam throws (throttled write, queue error, converter that will not launch) | `job.handler_error` | Handler catches, kills any child, releases the lease, returns the message immediately | Automatic, and the job is claimable at once rather than after a 121-minute lease |
| S3 or DynamoDB regional impairment | Backlog age, transient failure rate | Workers fail transiently; the queue absorbs up to 14 days of work | Latency event, not a data-loss event, provided the impairment is shorter than queue retention |
| Poison job cycling | DLQ depth > 0 | Attempt budget spent, then redrive at `maxReceiveCount` 10 | Sweeper marks it `failed` so the caller learns; DLQ samples drive the classification table |
| Webhook endpoint down | `IteratorAge` on the stream mapping, webhook DLQ depth | Bounded retries, then the S3 on-failure destination; the fan-out Lambda keeps the shard moving | One customer's outage stays one customer's outage |
| Bad release | Canary red; `job.failed{classification=transient}` rising | ECS deployment alarm aborts the rollout | Previous task definition revision redeployed; queued work is redelivered, not lost |

## E. Disaster recovery

Single-region by scope, with a rebuild-and-replay posture rather than a warm standby. That is a deliberate trade: the workload is asynchronous and queue-buffered, so hours of regional unavailability cost latency and goodwill, not data.

| Asset | Protection | RPO | RTO |
|---|---|---|---|
| Job metadata (DynamoDB) | PITR, 35 days | ~5 minutes | ~1 hour to restore, plus a swap step — PITR restores to a *new* table, it does not restore in place |
| Results (S3) | None — derived data | n/a | Regenerate by re-submitting; cost is recompute |
| Inputs (S3) | Customer-owned; versioning recommended to them | n/a | n/a |
| Container image | **ECR is regional** — the image must be replicated to the recovery region in advance, or there is nothing to run | n/a | Replication is a prerequisite, not a recovery step |
| Infrastructure | The CDK app is the only source of truth | n/a | Under an hour to stand up, *if* the Fargate quota in the destination region has been raised in advance |

The two long poles are both pre-work rather than recovery work: the destination region's Fargate quota and the ECR replication rule. Recovery for in-flight jobs is mechanical — every record that is not terminal is re-submitted, and the claim/lease logic makes a double submission safe. I would exercise this quarterly: restore the table into a staging account, replay 100 jobs, and confirm every one reaches a terminal state.

One retention caveat that belongs in the same conversation: DynamoDB TTL deletes within about 48 hours of expiry, not at it. That is fine if 90 days is a retention *floor*; if it is a compliance ceiling, TTL alone does not satisfy it and a scheduled purge does.

## F. The rest of the dashboard, and the sweeper's access pattern

Beyond the five alarmed signals in §4: `job.kill_failed` above zero pages, because it means orphans are accumulating and the fleet is heading for OOM; conversion duration p99 by kind is the input for tuning the deadlines and their alarm; ECS task stop reasons grouped by `OutOfMemoryError` catch a sizing regression before customers do; and a weekly cost-per-job figure (slot-hours ÷ jobs, by kind) is the cheapest early warning that a converter release doubled runtime. The dashboard is one row per fleet — backlog age, running tasks, terminal outcomes by classification, duration p99 — so the first question on a page, "is this one fleet or both?", is answered before the runbook is opened.

The sweeper's access pattern is the one thing in this design that could quietly cost more than it saves. "Leases expired beyond any possible in-flight message" is a time-based predicate over non-terminal jobs, and if it is implemented as a minute-by-minute `Scan` of a table holding 90 days of items (~90,000 rows), that is ~11,250 RRU per pass and **~$122/month** — more than every other control-plane line combined. The right implementation is a sparse GSI keyed on `leaseExpiresAt`, populated only while a job is non-terminal, which turns each pass into a small bounded query. The cost table above carries the Scan figure rather than the index figure, because the index is not built yet.
