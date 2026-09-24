# Runbook: Horizon sync lag

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Sync lag | p95 `horizon_sync_lag_seconds` > 300 s over 15 min | **P2** | Platform on-call |
| Sync stalled | No `horizon_sync_runs_total{outcome="success"}` in 15 min | **P1** | Platform on-call |

Payment data is stale. Proofs generated now reflect a ledger state minutes or
hours old, so a recent payment may be missing from a proof that should include it.

**Why two alerts.** "Slow" and "stopped" need different responses and have
different worst cases. Lag that is merely high is bounded and self-correcting;
a stalled sync means staleness grows without limit, and a run counter alone
cannot tell the two apart.

## Diagnose

### 1. Slow or stopped?

```
rate(horizon_sync_runs_total[15m])
sum by (outcome) (rate(horizon_sync_runs_total[15m]))
```

- **No runs at all** → the scheduler is not firing. Step 2.
- **Runs succeeding but lag rising** → throughput below ledger production. Step 4.
- **Runs failing** → step 3.

### 2. Is the process alive and scheduling?

Check that the application is running and that `@nestjs/schedule` is active. A
job that stopped scheduling emits no failures — silence is the only symptom,
which is exactly why the stalled alert is expressed as an absence.

Also check `job_runs_total{job="anchoring_worker"}`. If *every* scheduled job
went quiet, the problem is the scheduler or the process, not this workflow.

### 3. Why are runs failing?

```
sum by (outcome) (rate(horizon_sync_runs_total[15m]))
```

Filter logs to `workflow=horizon_sync` over the window. Common causes:

- **Horizon unreachable or rate-limiting** — check the Stellar status page.
- **Database write failures** — see [database-health.md](database-health.md).
- **Cursor problem** — a malformed or reset paging cursor causes repeated
  failures at the same position.

### 4. Are runs simply too slow?

```
histogram_quantile(0.95, horizon_sync_duration_ms)
```

If a run takes longer than the interval between runs, lag grows monotonically
even though every run "succeeds". This is the failure mode that looks healthiest
on a naive dashboard.

Backlog after an outage behaves the same way: the sync is catching up correctly
and will recover on its own. Distinguish the two by whether lag is falling.

## Mitigate

| Cause | Action |
|---|---|
| Horizon outage | Nothing local helps. Communicate and wait; sync resumes automatically. |
| Horizon rate limiting | Reduce request rate or page size. Confirm the configured endpoint is the intended one. |
| Process not running | Restart. Confirm all scheduled jobs resume, not just this one. |
| Runs slower than the interval | Increase page size or reduce per-run work. Widen the interval only as a stopgap — it hides the problem. |
| Catching up after an outage | Do nothing. Confirm lag is falling and let it drain. |
| Database write failures | Follow [database-health.md](database-health.md). |

## Verify

- `horizon_sync_lag_seconds` p95 back under 60 s.
- Successful runs recorded consistently over at least three intervals.
- Run duration comfortably shorter than the interval, or lag will simply climb
  again.

## Escalate

- Lag exceeds one hour.
- Horizon has been unavailable for more than 30 minutes — this becomes a
  customer-communication decision, not an engineering one.
- A cursor or data-integrity problem is suspected, where a naive restart could
  skip ledgers.
