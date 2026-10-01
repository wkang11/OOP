# Interview tomorrow — ITpipes conversion service

**Tonight:** read §1–§5 once, out loud if you can.  
**Morning:** read only §1 (the 2-minute opening) and the number table.  
**If they let you pick:** go deep on monitoring, not on more AWS services.

This is a 60-minute design + code review. They will change the facts mid-session. They will spend a lot of time on “how do you run this in production.”

---

## 1. The 2-minute opening (say this first)

Do **not** start with a diagram. Start with the idea.

> Callers send us a pointer to a file in S3. We convert it. We put the result back in S3. The file itself never goes through our API.
>
> There are two kinds of work, and they are nothing like each other:
>
> - **Import** — read an old Access database, write JSON. Seconds to a few minutes. Maybe 500 MB out.
> - **Export** — take JSON plus videos and images, write a zip. Tens of minutes. 10 to 40 GB out.
>
> The team’s first design used **one queue, one worker size, and one 30-second timeout** for both. That is the whole problem. Almost every bug I found is a version of “we treated these as the same job.”
>
> I kept their services — API Gateway, Lambda, DynamoDB, SQS, Fargate. I changed three things:
>
> 1. **Split** imports and exports into their own queues and their own worker fleets.
> 2. **Size** the machines for a 2 GB, single-threaded conversion — not 10 jobs on a 4 GB box.
> 3. **Stop pretending a message is delivered exactly once.** SQS delivers at least once. Two workers can see the same job. Only one of them is allowed to finish it.

Then walk one import. Then say what is different for an export. Then volunteer how it fails. Then close on “how I ship and watch it.” That order keeps you explaining, not defending.

**Hour budget if you get to choose:** 5 min story, 10 min failures, 15 min ops, 15 min code, rest for their new facts.

---

## 2. Words they will use (30 seconds each)

You do not need to lecture these. You need them ready if someone says the word.

| Word | In English |
|---|---|
| **Job record** | The row in DynamoDB. It is the truth. Status is `queued`, `running`, `succeeded`, or `failed`. |
| **Queue message** | A sticky note that only says `{jobId}`. It is **not** the truth. If the note and the row disagree, believe the row. |
| **Claim** | A worker saying “this job is mine now.” It works only if no one else has claimed it. |
| **Version** | A number on the row. Every write must say “I last saw version 4.” If the row is already 5, your write is thrown away. That is how two workers cannot both publish. |
| **Lease** | A timestamp: “I own this job until 3:17.” A second worker that sees a live lease puts the note back and does nothing. |
| **Visibility timeout** | How long SQS hides a message after a worker picks it up. If the worker dies, the message reappears after this time. For exports I set it to 125 minutes so a 120-minute job is not stolen mid-run. |
| **Heartbeat** | Every 60 seconds the worker tells SQS “still working, keep hiding the message.” |
| **Ack** | Delete the message. The work is done (or we have given up). |
| **Retry** | Put the message back so someone can try again. |
| **DLQ** | Dead-letter queue. After too many receives, the note goes here so it stops looping. A sweeper later marks the job `failed` so the caller is not left hanging. |
| **Attempt** | How many times we actually ran the converter. **This** is the retry budget (3). |
| **receiveCount** | How many times SQS handed the note out. This is **not** the budget — a “please wait, someone else has it” still counts as a receive. |
| **Object first, record second** | Write the file to S3, *then* mark the job succeeded. Never tell the caller “here is your file” before the file exists. |
| **Per-attempt key** | Each try writes `…/attempts/3/result.json`. Try 2 cannot overwrite try 3’s bytes. |
| **Kill and reap** | When time is up, stop the child process **and wait until it is actually gone**. If you only “time out” and walk away, the child keeps 2 GB of RAM and the next try starts next to it. That is how the box runs out of memory (exit 137). |
| **Permanent vs transient** | Permanent = this file will never convert (exit 2, “table missing”). Fail now. Transient = maybe luck next time (exit 137, out of memory). Retry. |
| **Sweeper** | A tiny Lambda every minute. Its job: if a job has been sitting with an expired lease and nobody is working it, mark it failed. **This is what makes “the caller always gets an answer” true.** |
| **Canary** | Every 5 minutes we submit one tiny import and one tiny export. If they stop succeeding, something is broken even if no customer is sending work. |
| **Stop vs reverse** | Stop = set the fleet to zero machines. Work sits in the queue. Reverse = put the previous software version back. They are different buttons. |

---

## 3. Walk through one import (the story they asked for)

Say each step in one sentence. The “why” is only if they stop you.

1. **Caller submits.** `POST /jobs` with the file’s S3 key and an idempotency key (“if I send this twice, it is the same job”).
2. **API writes the row.** DynamoDB, status `queued`. The idempotency key **is the row’s key**, not a search. Searching an index can miss a write that just happened, and two clicks would create two jobs.
3. **API drops a note** on the imports queue: only `{jobId}`. Returns `202` + the id.
4. **A worker picks up the note**, reads the row (a fresh read, not a cached one), and **claims** it: status `running`, attempt + 1, lease set, version must still match. If the version does not match, someone else already has it — put the note back, do not convert.
5. **Convert**, 15-minute deadline, in the same process (TypeScript library).
6. **Write the JSON to S3 first**, at `imports/{id}/attempts/{n}/result.json`.
7. **Then mark the row `succeeded`**, pointing at that file. Same version check. If we lost the race, throw our result away. The good file is already safe under a different key.
8. **Ack** the note.

### Export — same story, four extra sentences

- Its **own** queue and fleet.
- **One job per machine**, not two. A 40 GB zip needs about 100 GB of scratch. The disk is 200 GB. Two jobs would leave no room for the OS image.
- Deadline is **120 minutes**. Visibility timeout is 125 minutes, refreshed every 60 seconds. We also tell ECS “do not kill this machine for a deploy or a scale-in” for the whole job. Fargate will only wait 2 minutes when stopping a task, so a 40-minute export **cannot** finish politely. We have to hold the machine.
- The converter is a **vendor Java program**. We wrap it. We are not allowed to change it. We do read its exit code, so we can tell “bad file” from “out of memory.”

### Failures — volunteer these before they ask

This is the part that wins the hour.

- **Two notes for the same job, 100 ms apart.** Only one claim wins. The other puts the note back.
- **Time runs out.** Kill the child **and wait until it is gone**, then retry. Walking away is the original bug: the ghost process keeps 2 GB, the retry starts next to it, the box dies with exit 137.
- **Bad file (exit 2).** Fail on the first try. Retrying “table missing” three times wastes three export slots.
- **Flaky crash (exit 137).** Put the job back to `queued` and tell SQS “show this note **right now**.” If you forget that, the note stays hidden for 125 minutes and your own alarm pages you.
- **A slow try finishes after a newer try already published.** Version check fails. We discard it. We never overwrote the good file.
- **The worker dies.** Lease expires. Another worker claims the next attempt. If the note is gone too, the **sweeper** marks the job failed. No one polls forever.
- **It keeps failing.** After 10 receives the note goes to the dead-letter queue. Sweeper marks the job failed. The caller always learns.

**The one sentence they will test:**  
“`attempt` is how many times we ran the converter. `receiveCount` is how many times SQS handed the note out. They are different, because ‘please wait’ still counts as a receive. That is why the dead-letter threshold is 10, not 3.”

### How the caller finds out

- Poll `GET /jobs/{id}` — the four statuses are just the row.
- Or a webhook. The webhook is fired off the **DynamoDB write that said succeeded/failed**, not off the worker. If the worker dies after saving, the webhook still happens.
- The stream Lambda **only** drops an event on a delivery queue. It does not call the customer. If it called the customer on the stream itself, one down customer would block **every** customer for up to 24 hours.

### How a change gets to production (they will spend time here)

One CDK app in the same repo as the code: queues, tables, machines, alarms. An alarm number is reviewed in the same pull request as the code that can trip it.

1. Pull request: typecheck, tests, `cdk diff`.
2. Merge: build **one** image, tag it with the git commit, scan it, push it.
3. Staging. Every 5 minutes a canary import + export must pass.
4. Production: rolling deploy of **that same image**, one fleet at a time, **imports first** (blast radius is minutes, not tens of minutes).

**A bad release looks like:** canary red, or “our” failures (not the customer’s bad files) jump on the new image tag, or new tasks will not start.

**Two buttons, say both:**

- **Stop** = desired count to 0. The queue holds the work. You lose time, not data.
- **Reverse** = put the previous image back. We also attach ECS “deployment alarms” so a jump in our-failure-rate rolls back by itself. The built-in circuit breaker only catches “the task would not start.” A task that starts and fails every job never trips it.

---

## 4. The three risks (their proposal)

1. **Healthy jobs fail.** 30-second timeout on work that takes minutes. Timeout does not kill the child. Ghost process + retry = out of memory. After three receives a good job is marked failed. *Customer sees:* “your file is bad” when it is not — or they poll forever.
2. **Two workers, last write wins.** Both convert. Both write the same `result.json`. The slower one overwrites the faster one. *Customer sees:* a half-written zip.
3. **One size for both jobs.** 10 jobs × 2 GB on a 4 GB box. 10 single-threaded jobs on 1 CPU, each at 1/10 speed. 40 GB zip on a 20 GB disk. *Customer sees:* a 5-second import waits behind a 40-minute export all evening.

**I left two things alone, on purpose:**

- DynamoDB + API Gateway + Lambda as the front door. The access pattern is “get one job, write it once.” Revisit if we need list-by-customer reports, or if write collisions stay above ~1%.
- One codebase / one image for both converters. I split queues and machines, not repos. Revisit if starting the image (JVM and all) eats more than ~10% of a typical import.

---

## 5. Numbers to say without looking down

Do the arithmetic out loud. They care that you can, not that it is exact.

**Rates I used (us-east-1, on-demand):**  
$0.04048 per vCPU-hour, $0.004445 per GB-hour, $0.000111 per extra GB of disk per hour.

**One slot costs:** import **$0.058 / hour**, export **$0.137 / hour** (export has 200 GB of disk).

**Bad onboarding evening — 3,000 jobs, 80/20 mix:**

- 2,400 imports × 3 min = **120 slot-hours** → drain in 1 hour → **60 machines**
- 600 exports × 30 min = **300 slot-hours** → drain in 4 hours → **75 machines**
- Peak: **135 machines, 270 vCPU, about $48**
- Money is not the problem. The default Fargate quota is **6 vCPU**. We need 270. Raise it **before** the evening. Also use bigger subnets — 135 machines need 135 IPs.

**Normal month — 1,000 jobs/day:**

| Line | About |
|---|---|
| Compute | **$670** (imports $70, exports $410, then ×1.4 because machines take a minute to start and sit idle between bursts) |
| S3 if we keep files 90 days | **$8,600** |
| Everything else | **~$300** |
| **Total** | **~$9,600, and 90% is S3** |

**The one change that cuts the bill:** delete export zips after **14 days**. Keep import JSON for 90 days (exports **read** that JSON). Result: about **$2,600 / month**, a **73%** cut.

S3 folder names must be real prefixes. `jobs/*/attempts/*` matches **nothing** — the `*` is a character, not a wildcard. Use `exports/…` and `imports/…`.

**If they say “Fargate is expensive”:** compute is 7% of the bill. The expensive thing is keeping 40 GB zips around.

**If they say “why 2 CPUs on a 1-job export box”:** the conversion is one thread. Upload, zip, and Java GC are not. I did **not** cut to 1 CPU. I would measure first. Cutting would save ~$150/month and drop the evening from 270 to 195 vCPU.

**NAT trap:** if we send 240 TB/month through a NAT gateway both ways, that is about **$13,000**. An S3 gateway endpoint (free) is mandatory.

---

## 6. If they say this, do **not** agree

These sound smart. They are wrong.

| They say | You say |
|---|---|
| “Fargate cannot attach 200 GB of disk.” | It can. Default 20 GB, you can set 21–200 GB. You pay for the extra. |
| “Just raise the stop timeout so exports finish during a deploy.” | Fargate’s max stop wait is **120 seconds**. A 40-minute export cannot drain. That is why we lock the machine. |
| “125-minute visibility timeout is not allowed.” | Cap is 12 hours. 125 minutes is fine. AWS even tells you to heartbeat for long jobs. |
| “Locking the machine only stops scale-in. A deploy will still kill the export.” | The same lock covers deploys. You can hold it up to 48 hours. 2 hours fits. |
| “Your lease uses wall clocks, so two workers can publish two different results.” | No. The **version number** decides who may write. A clock that is wrong can make us **do the work twice**. It cannot make us publish two winners. |
| “The queue cannot hold 14 days of work.” | 14 days is the maximum. The default is 4 days — we have to set it. |
| “You cannot fire webhooks from a DynamoDB stream.” | You can. The risk is not the trigger. The risk is one bad customer blocking the stream for 24 hours — that is why we fan out to a delivery queue. |

---

## 7. Questions, in the words you will say

Each one: **they ask** → **you say** → **if they push**.

### Q1. Why is the timeout bug worse than two workers overwriting a file?

**You say:** At 30 seconds, almost every real job times out. The service has roughly a **0% success rate**. There is no working system for the overwrite bug to damage. I fixed both in the same change. The ranking is “what makes this a service,” not “what is more interesting.”

**If they push “a wrong file is worse than a failed job”:** Yes — *after* the timeout is fixed. If the timeout is still 30 seconds, customers never get a file at all.

### Q2. You said receiveCount is the wrong counter. Why was the dead-letter still “3 receives”?

**You say:** That was a mistake I caught on a second pass, and I fixed it. It is now 10. `attempt` is the real budget. The dead-letter is only “this note is poison, stop looping.”

Why 3 was wrong: every “please wait, someone else has it” still counts as a receive. One duplicate cuts your 3 tries down to 2. Two duplicates cut it to 1. Then a good job dies in the dead-letter queue.

**If they push:** “I fixed it in the code and left it in the config. That is on me.”

### Q3. Lease uses clocks. Two workers, two results?

**You say:** They cannot both **publish**. Every write checks the version. The slower one loses and we drop it.

What clock skew *can* do: a machine with a slow clock writes a lease that other machines think is already expired. Then two machines convert the same 40 GB export. We pay twice. The row still ends with one winner.

**If they push:** volunteer that — “skew costs money, not a wrong file.”

### Q4. `jobs/*/attempts/*` as the delete-after-14-days rule?

**You say:** That pattern matches nothing in S3. Prefixes are literal. I now use `exports/` (delete at 14 days) and `imports/` (keep 90 days, because exports read them). I also abort unfinished multipart uploads — a failed 40 GB upload leaves paid leftover parts.

**If they push the 78% vs 73%:** the 78% was never real. The rule it sat on did not work.

### Q5. Is the database write a replace of the whole row, or an update of some fields?

**You say:** An **update** of the fields the worker owns, plus a **remove** of the lease when we let go. A full replace would wipe the idempotency key and the 90-day expiry on the first claim.

**If they push:** the first test double replaced the whole row, so one test was green for the wrong reason. I fixed the double to merge.

### Q6. Consistency — what did you miss?

**You say, three things:**

1. The worker’s read before a claim must be a **strong** read. A stale read loses the claim for no reason. The public `GET` can stay cheap and a bit stale.
2. Old rows have no `version`. The condition must allow “version is missing.” This exercise is an existing service, so those rows are the normal case.
3. You cannot trust an index to enforce “one job per idempotency key.” Two requests at the same moment can both miss. The key **is** the row key, and the write is conditional.

### Q7. DynamoDB throws *after* a 30-minute export finished?

**You say:** We retry that last write a few times, and the whole handler is in a try/catch. If we did nothing: the note is not acked, the row stays `running` with a 2-hour lease, every retry sees “someone is working,” and the customer waits two hours for a job that already succeeded.

### Q8. Scale from zero — what is the metric when there are zero machines?

**You say:** “messages / running machines” is divide-by-zero. No datapoint. The fleet never starts. AWS’s own formula is: if machines are 0 and messages are > 0, pretend the number is huge so we scale out.

Also: “visible messages” ignores messages already being worked. During a long export burst the metric drops to 0 and the system tries to scale **in**. That is why we lock the machine while a job runs.

### Q9. You gave three alarms. What is missing?

**You say:** The three I picked are right. Two more are load-bearing:

- **Dead-letter queue depth > 0** — page. That is where unrecoverable jobs land.
- **Sweeper is alive** — if it stops, jobs can sit in `running` forever and nobody pages.
- Also: stream “how old is the oldest unprocessed webhook event,” and the canary must treat **silence** as an outage (if we stop submitting canaries, that *is* the outage).
- Cheap extra: daily S3 size per folder. One broken delete-rule turns a $2,600 month into a $9,600 month.

### Q10. You put jobId on every metric. What does that cost?

**You say:** In CloudWatch, every unique **dimension** combination is a separate paid metric. `jobId` as a dimension is ~1,000 new metrics a day. I put `jobId` in the **log line** (free to search) and only use `kind` and `classification` as dimensions.

**If they push:** I also set log retention. A Java process that prints for 40 minutes can be 50 MB. 200 exports/day × 30 days ≈ 300 GB of logs ≈ $150, against a $25 log budget.

### Q11. One customer’s webhook is down. What about everyone else?

**You say:** If we retry forever on the stream itself, that customer blocks the shard for up to 24 hours. Everyone’s webhooks stall. So the stream Lambda only drops a message on **our** delivery queue. Each customer’s failures stay on their messages.

Hold this: firing the webhook from the **saved** status change is still right. We just must not deliver on the stream.

### Q12. An export fails after 5 seconds. When does try 2 start?

**You say:** If we only “retry” and leave the default hide-time, try 2 starts **two hours** later — and that pages us, because our export backlog alarm is 60 minutes. On a retry we must tell SQS “show this now.”

### Q13. How do you know a release is bad before customers do? How do you stop it?

**You say:** Canary every 5 minutes. Our-failure-rate by image tag. Tasks that will not start. **Stop** = machines to zero. **Reverse** = previous image. Circuit breaker is not enough (see §3).

Export deploys can take **up to two hours** because we will not kill in-flight exports. Say that up front.

### Q14. Why not Step Functions?

**You say:** This is one step: claim, convert, publish. Step Functions is for many steps, waits, or approvals. It would add a second place that thinks it owns job state. The hard problems (two workers, one writer, 2-hour jobs) stay the same.

**If they push:** I would get a free per-job timeline. I am building that with logs instead.

### Q15. Why not Batch? Why not plain EC2?

**You say:** Batch is close, but we already run ECS, Batch-on-Fargate has the **same** CPU quota and 200 GB disk cap, and Batch’s own retries would fight our `attempt` counter — the bug I just removed.

EC2 is cheaper per CPU, especially Spot, and local disks are bigger. We then own patching, replacing bad instances, and draining. At $670 of compute on a $9,600 bill, that extra work buys 7% of the wrong line. At 10× volume I would come back to EC2.

### Q16. Why not Lambda for imports?

**You say:** Lambda dies at 15 minutes. Imports are “seconds to several minutes” with no promised max. The slow ones are exactly the ones that would die. Also: two ways to ship and watch one library. Import compute is $70/month. Not worth the split — **unless** we measure p99 well under 15 minutes. Then Lambda is probably right, and it removes half the CPU-quota problem.

### Q17. Why 2 CPUs on a 1-job export?

**You say:** For the converter, it does not need it. For upload, zip, and Java, it might. I left 2 CPUs and called it “measure me.” Cutting to 1 CPU / 6 GB is $0.087/hour vs $0.137, and the evening drops 270 → 195 vCPU.

The better long-term fix: stream the zip to S3 while we build it, instead of parking 100 GB on disk. Then two jobs might fit.

### Q18. Why can’t a failed export resume at minute 39?

**You say:** Resume means checkpoints inside the vendor Java program. We may wrap it, not change it. Saving the already-downloaded videos would save about **seven cents** and lose the clean slate we want after an out-of-memory. The real cost is the customer waiting, not the money. If export p99 gets near 120 minutes, I would revisit.

### Q19. What breaks at 10×?

**In this order:**

1. CPU quota and IPs — already tight on a 1× onboarding night.
2. S3 — $8,600 becomes ~$86,000 if we keep files 90 days. The 14-day rule is then the design, not a saving.
3. Sweeper — scanning the whole table every minute is already ~$122/month. Needs an index of only unfinished jobs.
4. Webhooks — more terminal events through a few stream shards.

What does **not** break: the queues, the claim/version rules, DynamoDB on-demand.

At 10×, compute is no longer 7% of the bill. That is when EC2 and Lambda-for-imports come back.

### Q20. Budget is cut in half. What do you cut?

**You say:** Retention. Nothing else is big enough. 14-day export zips take us from $9,600 to about $2,600 by themselves. Next: 1 CPU on exports (~$150). I would **not** cut backups, the canary, or the dead-letter / sweeper alarms. Those are a few dollars. They are the difference between “we see it” and “it fails quietly.”

**If they push:** this is a product question — will customers accept 14-day zips? If no, my cost story changes. The math does not.

---

## 8. They change the facts mid-session

Pattern: name the piece that already absorbs it, name the number that moves, name the tripwire you already wrote down.

**“The Java process leaks memory across jobs.”**  
We already kill the child after every job. Add: recycle the **machine** after N jobs. The queue holds the work, so this is free. Watch for exit 137 that tracks **how old the machine is**, not which file it saw.

**“p99 import is 22 minutes, not 3.”**  
Then my 15-minute deadline is creating failures — the #1 bug again. Raise the deadline above p99. Import compute goes ~$70 → ~$500. Still small. The 1-hour drain for 2,400 imports may become impossible under the CPU quota — change the drain target, not the design. The alarm that should have caught this is “timeouts > ~1/hour.”

**“30% of messages are delivered twice.”**  
The claim/lease design is *for* this. Raise the dead-letter well above 3 (already done). Also hide a “please wait” note only until the lease ends, not for the full 125 minutes.

**“The CPU quota increase is not approved yet, and onboarding is tonight.”**  
The queue holds 14 days. The evening gets slower, it does not lose work. I would shrink export machines to 1 CPU to fit under the cap.

**“Keep packages 7 years.” / “10% of downloads leave AWS.”**  
Neither changes the boxes. Both change the bill. 7 years: only **that** customer’s prefix, cheap archive storage, bill them. Do not keep everyone’s zips for 7 years. Internet download of 10% of zips is $600–1,100/month — then a CDN or “write into the customer’s bucket” beats more Fargate tuning.

**“Callers want to cancel a running job.”**  
We already have kill-and-reap. A cancel flag on the row, worker sees it on the next heartbeat, kills the child, acks, marks failed (or a new status). The spec only has four statuses — that is a product talk first.

**“Second region.”**  
Rebuild from the CDK app. Database backup is ~5 minutes old. Do not forget: the container image must already exist in the other region, and Fargate quota there must already be raised. That is a runbook, not a redesign.

---

## 9. Weak spots — say the weakness first

- **No heartbeat in the first draft.** The 125-minute hide-time was doing that job. Wasteful, not incorrect. About a day of work.
- **Sweeper is designed, not coded.** It is what makes “always a final status” true. It cannot ask SQS “is this one message in flight?” It must use time. Do not scan the whole table every minute — index only unfinished jobs.
- **We only know one permanent error (exit 2).** A wrapper that drops the exit code would retry a bad file three times. Unknown errors get one retry and their own counter so they cannot hide.
- **Converter crashes and platform crashes share the same 3 tries.** Three unlucky machine deaths can fail a good export. Two counters would be better.
- **I apply a 1.4× “machines sit idle” factor to the month, not to the $48 evening.** On purpose: a 4-hour packed evening is not idle. Say it.
- **I priced S3 at one rate, not the cheaper bulk rate.** About 4% off. Easier to audit. Say it.
- **A 3-minute import waiting a full hour to drain is a 20× delay that saves no money.** I would drain faster if the CPU quota allows.

---

## 10. If the room goes quiet, say these three

1. **“I fixed the retry counter in the code and first left it at 3 in the queue. That is a code-plus-config bug. I raised the dead-letter to 10.”**
2. **“A 5-second failed export should not wait 2 hours to retry. That would page me on my own alarm. On retry, un-hide the note immediately.”**
3. **“The 73% cheaper bill only works if customers accept 14-day zips. If they do not, the next lever is download traffic, not cheaper machines.”**
