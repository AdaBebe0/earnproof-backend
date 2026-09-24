# Runbook: Anchoring backlog

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Anchoring backlog | `anchoring_backlog_size` > 100 pending for 15 min | **P2** | Platform on-call |
| Anchoring permanent failures | `anchoring_intents_total{job_result="failed_permanent"}` > 1% of terminal intents over 1 h | **P2** | Platform on-call |

Proofs are not reaching the chain. They remain valid and verifiable through the
API; what is missing is the on-chain anchor.

**Why 100.** Above the worker's steady drain rate, so the queue grows rather
than clears. **Why permanent failures are separate:** a retry is the system
working as designed, while a permanent failure is a proof that will never anchor
without a human. Alerting on both together would let the serious signal hide
inside the benign one.

## Diagnose

### 1. Growing, flat, or draining?

```
anchoring_backlog_size
sum by (job_result) (rate(anchoring_intents_total[15m]))
```

- **Growing** → arrival exceeds throughput. Steps 2–3.
- **Flat and high** → the worker is stuck or not running. Step 2.
- **Draining** → recovering from an earlier outage. Confirm the slope and wait.

### 2. Is the worker running?

```
rate(job_runs_total{job="anchoring_worker"}[15m])
```

No runs means the poll loop is not firing. Check the process and whether other
scheduled jobs also went silent — if so, the scheduler is the problem, not this
workflow.

Intents stuck in `PROCESSING` belong to a crashed worker. The reconciler resets
them after five minutes; confirm `job_runs_total{job="anchoring_reconciler"}` is
also running, or nothing will unstick them.

### 3. Retrying or failing permanently?

```
sum by (job_result) (rate(anchoring_intents_total[15m]))
histogram_quantile(0.95, anchoring_attempt_duration_ms)
```

- **`retried` dominant** → transient upstream trouble. Backoff is doing its job;
  the queue drains once the upstream recovers.
- **`failed_permanent` dominant** → these will never retry. This is the serious
  case; continue to step 4.
- **Attempt duration high** → each attempt is slow, so throughput collapses even
  with a healthy success rate.

### 4. Classify the permanent failures

Filter logs to `workflow=anchoring` with `outcome=server_error`. The stored
`lastErrorSafe` field is already sanitised and is the right thing to read.

Common causes, in rough order of likelihood:

- **Misconfigured contract ID** — every intent fails identically and immediately.
- **Issuer not registered or not active on-chain** — the registry rejects the
  write.
- **Protocol paused** — an intentional containment action upstream. Confirm
  before treating it as a fault.
- **Schema version not approved** — a deployment mismatch between the backend's
  configured version and what the contract accepts.
- **Source account underfunded** — the submitting account cannot pay fees.

> Individual proof IDs stay in the database. Report counts, not identifiers.

## Mitigate

| Cause | Action |
|---|---|
| Worker not running | Restart; confirm both worker and reconciler resume. |
| Stellar RPC unavailable | Wait. Backoff handles it; the queue drains on recovery. |
| Underfunded source account | Fund it. Permanently-failed intents need requeuing separately. |
| Wrong contract ID or schema version | Fix configuration and redeploy. Requeue affected intents afterwards. |
| Protocol paused on-chain | Confirm this is intentional. If so, no action — anchoring resumes on unpause. |
| Arrival rate genuinely exceeds capacity | Raise batch size or run additional workers. |

Intents that failed permanently do **not** retry on their own. After fixing the
root cause, requeue them deliberately, and only once you are confident the cause
is gone — a bulk requeue into an unfixed system just re-fails everything.

## Verify

- Backlog trending down and below 50.
- `failed_permanent` back under 1% of terminal intents.
- Attempt duration p95 back to baseline.
- Previously stuck intents have reached `CONFIRMED`, not merely left `PENDING`.

## Escalate

- Backlog above 500, or growing for more than an hour.
- Permanent failures exceed 10% — suggests configuration rather than transience.
- The fix requires an on-chain administrative action such as issuer
  re-registration or schema approval.
- Anchoring has been down long enough to breach a customer commitment.
