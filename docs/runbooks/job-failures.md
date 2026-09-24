# Runbook: Background job failures

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Job failure | Any job's success rate < 95% over 1 h | **P2** | Platform on-call |
| Job silent | No run recorded in two scheduling intervals | **P2** | Platform on-call |

Scheduled work is not completing. Jobs cover anchoring, reconciliation, session
cleanup, and retention cleanup.

**Why the silence alert exists.** A job that stopped scheduling emits no failures
at all. Absence is the only available signal, and without this alert a stopped
job is invisible until something downstream breaks.

## Diagnose

### 1. Which job, and is it failing or silent?

```
sum by (job, outcome) (rate(job_runs_total[1h]))
rate(job_runs_total[15m])
```

- **One job failing** → that workflow's dependency. Step 3.
- **All jobs silent** → the scheduler or the process. Step 2.
- **One job silent** → that job's registration, or it is stuck mid-run.

### 2. Is the process running?

If every job went quiet simultaneously, the application is down or
`ScheduleModule` is not initialised. Check the process and restart.

A job stuck inside a run also reports as silent — it started and never finished.
Check `job_duration_ms` for a run that began and has no completion.

### 3. Follow the job to its own runbook

| Job | Depends on | Runbook |
|---|---|---|
| `anchoring_worker` | Stellar RPC, database | [anchoring-backlog.md](anchoring-backlog.md) |
| `anchoring_reconciler` | Database | [anchoring-backlog.md](anchoring-backlog.md) |
| `session_cleanup` | Database | [database-health.md](database-health.md) |
| `retention_cleanup` | Database | [database-health.md](database-health.md) |

Nearly every job failure is a database failure. Check
`database_probes_total{health="down"}` before investigating job logic.

### 4. How much work is affected?

```
sum by (job) (rate(job_records_affected_total[1h]))
```

A cleanup job reporting zero records is not necessarily broken — there may be
nothing eligible. Compare against the same window on previous days rather than
against zero.

> This counter is a count only. What was processed or deleted is never a metric
> dimension and never appears in the log line.

### 5. Is a lock stuck?

Retention cleanup coordinates single-run execution. A crashed run can leave the
coordination record held, blocking subsequent runs. That presents as silence, not
failure. Confirm the lock's age before assuming the scheduler is at fault.

## Mitigate

| Cause | Action |
|---|---|
| Process down | Restart. Confirm every job resumes, not just the alerting one. |
| Database unavailable | Follow [database-health.md](database-health.md). Jobs recover on their own. |
| Stuck coordination lock | Clear it once you have confirmed no run is genuinely in progress. |
| Job slower than its interval | Reduce batch size, or widen the interval to match reality. |
| Persistent failure in one job | Follow that job's runbook. |
| Job not registered after deploy | Configuration or module wiring. Roll back or fix and redeploy. |

## Verify

- Success rate back above 95% for the affected job.
- Runs recorded consistently across at least two intervals.
- Duration comfortably shorter than the interval.
- Any backlog accumulated while the job was down is draining.

## Escalate

- A job has been down long enough to accumulate a backlog that will not drain
  within one interval.
- Retention cleanup has been down long enough that records are being held beyond
  their intended lifetime. Treat this as a compliance question, not just an
  operational one.
- A job appears to have partially processed and left inconsistent state.
- Restarting does not restore scheduling.
