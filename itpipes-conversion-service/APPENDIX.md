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
| S3 storage, 90-day retention | (200 × 20 GB + 800 × 0.2 GB) × 30 = 125 TB/month; steady state ≈ 375 TB × $0.023 | **$8,600** |
| S3 requests | 6,000 exports × ~200 multipart parts = 1.2M PUT × $0.005/1,000 | $6 |
| DynamoDB on-demand | ~180k writes ($1.25/M) + ~600k eventually-consistent reads ($0.125/M) | $1 |
| SQS | ~3M requests × $0.40/M, including long-poll receives | $5 |
| API Gateway (HTTP API) + Lambda | ~630k requests | $2 |
| CloudWatch logs, custom metrics, alarms | ~10 EMF metrics with dimensions, a few GB of logs | $25 |
| VPC interface endpoints | ECR api + dkr, logs, STS × 2 AZ × $0.0104/hr × 730 | $61 |
| **Total** | | **≈ $9,400** |

**With a 14-day lifecycle expiry on results:** storage becomes 125 TB × 14/30 ≈ 58 TB × $0.023 ≈ **$1,341**, and the total lands near **$2,100** — a 78% cut from one rule. The rule is safe because results are derived data, re-creatable from inputs the customer owns, and the 90-day retention requirement is on job metadata (a DynamoDB TTL), not on 40 GB zips.

**Two sensitivities that matter more than the precision above.**

- *NAT gateway.* Workers in private subnets pulling 120 TB/month of S3 traffic through a NAT gateway would pay $0.045/GB in data processing: **~$5,400/month**, more than half the bill and more than eight times the compute. A gateway VPC endpoint for S3 costs nothing and removes the line entirely. This is the single highest-leverage decision in the network layout, and it is invisible on an architecture diagram.
- *Egress.* The estimate assumes consumers read packages in-region (callers are other ITpipes backend services), so internet egress is zero. If 10% of packages are downloaded over the internet, that is ~12 TB/month at $0.05–0.09/GB, or **$600–1,100/month** — at which point CloudFront or a customer-supplied destination bucket becomes the next optimization instead of the lifecycle rule.

## B. Slot formula derivation

`slots = min(vCPU, floor((memGiB − 2) / 2), floor(diskGiB / peakScratchGiB))`

A conversion is single-threaded and wants ~2 GB, so a slot costs one core and 2 GB. The memory term reserves 2 GB for the runtime, the JVM's non-heap overhead, and the S3 transfer buffers, then divides the rest. The proposed 1 vCPU / 4 GB with 10 concurrent messages violates both of the first two terms at once: 20 GB of demand against 4 GB, and ten runnable threads against one core, which is a fivefold memory oversubscription and a tenfold slowdown feeding a 30-second deadline.

The disk term is what forces exports to one slot. A 40 GB package needs roughly 100 GiB of scratch while media is staged and zipped, so 200 GiB of ephemeral storage supports one export, not two — even though the memory term would allow two. Fargate's default is 20 GiB, which does not fit a single package; 200 GiB is the maximum and is configured per task definition.

## C. Capacity planning for the onboarding evening

3,000 jobs = 2,400 imports + 600 exports. Import work: 2,400 × 3 min = 7,200 slot-minutes = 120 slot-hours. Export work: 600 × 30 min = 18,000 slot-minutes = 300 slot-hours.

| Target | Slots | Tasks | vCPU | Memory | Ephemeral disk |
|---|---|---|---|---|---|
| Imports drained in 1 hour | 120 | 60 | 120 | 480 GB | default |
| Exports drained in 4 hours | 75 | 75 | 150 | 600 GB | 15 TB |
| **Peak** | | **135** | **270** | **1.1 TB** | **15 TB** |

Cost for the evening: 60 × 1 h × $0.1165 + 75 × 4 h × $0.1365 ≈ **$48**. Money is not the constraint; four operational limits are.

1. **Fargate On-Demand vCPU quota.** The account default is far below 270. A quota increase is a lead-time item and must be requested before the first onboarding, not during it. If it is not raised, the fleet simply stops scaling and the only symptom is the backlog-age alarm — which is why that alarm's runbook names the quota first.
2. **IP space.** `awsvpc` gives each task an ENI, so 135 tasks need 135 addresses. A /24 (251 usable) survives one evening and not two concurrent ones; the worker subnets should be /22.
3. **Image pull.** 135 tasks pulling a ~1 GB image inside ten minutes is ~135 GB through the ECR endpoints, and it lands on the critical path of every scale-out. Keep the image small and use SOCI lazy loading if task start drifts above ~90 seconds.
4. **Egress to S3.** 12 TB written over four hours is ~850 MB/s aggregate, ~11 MB/s per export task — comfortable per task, and the reason the S3 gateway endpoint matters for the burst as well as for the bill.

**Scaling policy.** Target tracking on backlog-per-task (`ApproximateNumberOfMessagesVisible / RunningTaskCount`), target 2 for imports and 1 for exports, with separate policies per fleet. With ~90-second task starts the fleet is full in roughly ten minutes, so the first ten minutes of an onboarding burst are absorbed by the queue, not by capacity. Scale-in is the dangerous direction: a task holding a 40-minute export must not be chosen for termination, which is what `UpdateTaskProtection` is for.

## D. Failure scenarios

| Failure | How it is detected | Behaviour | Recovery |
|---|---|---|---|
| Worker task killed mid-conversion | Backlog age; `job.lease_held` on redelivery | Message redelivered after the visibility timeout; the lease has expired | Attempt `n+1` starts clean. Cost: one wasted attempt. |
| Converter hangs | `job.deadline_exceeded` | Deadline fires, child terminated and reaped, attempt released to `queued` | Retried within the attempt budget |
| Converter exits 2 | `job.failed{classification=permanent}` | Terminal on the first attempt, no retry | None needed; the input is bad. Weekly report, not a page. |
| Converter exits 137 (OOM) | `job.failed{classification=transient}`, ECS `OutOfMemoryError` stop reason | Transient retry | If it repeats, it is a sizing bug, not a flake — re-derive slots with the formula in §B |
| Duplicate delivery | `job.lease_held`, `job.claim_conflict` | Live lease defers the message; a stale write loses its condition | Automatic; the counters exist so it does not stay invisible |
| DynamoDB throttle during claim | Handler throws, message redelivered | No conversion started; nothing lost | Automatic |
| DynamoDB throttle on the *terminal* write | `job.stale_write_discarded` is silent here; shows as a re-run | The result exists in S3 but is not published; the job is retried and re-converted | Expensive — a bounded retry on the terminal write is the first NOTES item to close |
| S3 or DynamoDB regional impairment | Backlog age, transient failure rate | Workers fail transiently; the queue absorbs up to 14 days of work | Latency event, not a data-loss event, provided the impairment is shorter than queue retention |
| Poison job cycling | DLQ depth > 0 | Three attempts, then redrive | Sweeper marks it `failed` so the caller learns; DLQ sample drives the classification table |
| Bad release | Canary red; `job.failed{classification=transient}` by image tag | Circuit breaker aborts the rollout | Previous task definition revision redeployed; queued work is redelivered, not lost |

## E. Disaster recovery

Single-region by scope, with a rebuild-and-replay posture rather than a warm standby. That is a deliberate trade: the workload is asynchronous and queue-buffered, so hours of regional unavailability cost latency and goodwill, not data.

| Asset | Protection | RPO | RTO |
|---|---|---|---|
| Job metadata (DynamoDB) | PITR, 35 days | ~5 minutes | ~1 hour to restore into a new table |
| Results (S3) | None — derived data | n/a | Regenerate by re-submitting; cost is recompute, not recovery |
| Inputs (S3) | Customer-owned; versioning recommended to them | n/a | n/a |
| Infrastructure | The CDK app is the only source of truth | n/a | Under an hour to stand up in a second region |

The long pole in a real region evacuation is not the stack — it is the Fargate quota in the destination region, which is why the DR runbook opens with the quota request and why I would pre-raise it in one paired region. Recovery for in-flight work is mechanical: every job whose record is non-terminal is re-submitted, and the claim/lease logic makes a double submission safe. I would exercise this as a quarterly game day: restore the table into a staging account, replay 100 jobs, and confirm every one reaches a terminal state.

## F. The fourth signal, and the rest of the dashboard

**`jobs_awaiting_terminal`** — a gauge emitted by the sweeper Lambda each minute: jobs in a non-terminal state whose lease expired more than ten minutes ago with no message in flight. Page if it is above zero for ten minutes. This is the only *direct* detector of the worst customer outcome in the whole system, a caller waiting forever, and it is fourth only because it depends on the sweeper existing. Once the sweeper ships, it arguably belongs first.

Secondary panels, watched but not alarmed at launch: DLQ depth per queue (ticket above zero); webhook delivery failure rate and its DLQ; `job.kill_failed` (page above zero — it means orphans are accumulating and the fleet is heading for OOM); conversion duration p99 by kind, which is the input for tuning the deadlines in §2 item 3 and the deadline alarm; ECS task stop reasons grouped by `OutOfMemoryError`; and a weekly cost-per-job figure (task-hours ÷ jobs) split by kind, which is the cheapest early warning that a converter regression has doubled runtime.

The dashboard is one row per fleet — backlog age, running tasks, terminal outcomes by classification, duration p99 — so that the first question on a page ("is this one fleet or both?") is answered before the runbook is opened.
