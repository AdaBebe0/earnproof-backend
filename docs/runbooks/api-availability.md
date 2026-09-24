# Runbook: API availability

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| API 5xx rate | `http_requests_total{status_class="5xx"}` > 1% of total over 5 min | **P1** | API on-call |
| API 5xx spike | > 10% over 2 min | **P1** | API on-call |

The service is returning server errors. Users are seeing failures they cannot
work around. Both variants page immediately; the spike alert exists to catch a
bad deploy faster than the 5-minute window would.

**Rationale for 1%.** Baseline 5xx is near zero. One percent is high enough that
a single misbehaving client cannot trigger it, and low enough to fire before
users escalate.

## Diagnose

Work down the list. Each step is cheaper than the one after it.

### 1. Is it one route or all of them?

```
sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))
```

- **One route** → a code path, not the platform. Continue to step 3.
- **All routes** → a shared dependency. Skip to step 2.
- **`route="other"`** → traffic to unmapped paths. Often a scanner rather than a
  real regression; confirm against total volume before treating it as an incident.

### 2. Is the database healthy?

```
database_probes_total{health="down"}
histogram_quantile(0.95, database_probe_duration_ms)
```

If probes are failing or slow, this alert is a symptom. Go to
[database-health.md](database-health.md) and treat that as the incident.

### 3. Did something deploy?

Correlate the onset with the deployment timeline. A step change that begins
within a minute of a release is a regression until proven otherwise.

**If a recent deploy lines up, roll back first and diagnose after.** Rollback is
the fastest mitigation available and does not require understanding the bug.

### 4. What is actually failing?

Filter logs to the affected workflow and the incident window. The log lines carry
the exception class name and a redacted message, which is normally enough to
classify the failure. Take a `requestId` from a representative failing line.

> Error messages in logs are redacted by design. If the class name is genuinely
> insufficient, look the record up in the database using the correlation ID.
> Do not paste the record into the incident channel.

### 5. Is it upstream?

If failures concentrate in proof or payment routes, check Horizon and Stellar RPC
reachability. An upstream outage surfaces here as 5xx even though the service
itself is healthy.

## Mitigate

| Cause | Action |
|---|---|
| Bad deploy | Roll back. Diagnose on the restored version. |
| Database down or saturated | Follow [database-health.md](database-health.md). |
| Upstream Stellar outage | Confirm on the Stellar status page. Communicate; do not roll back — nothing local will help. |
| One tenant or client driving load | Consider a targeted rate limit rather than a global one. |
| Unhandled exception on one path | Hotfix if the path is isolated; otherwise roll back. |

## Verify

- 5xx rate back under 1% and holding for 15 minutes.
- p95 latency also recovered — a rollback that fixes errors while leaving latency
  elevated means there was a second cause.
- No new alert has fired downstream, particularly anchoring backlog: a period of
  API failures often leaves queued work behind.

## Escalate

Escalate to the platform lead when:

- 30 minutes have passed with no identified cause.
- Rollback did not restore the error rate, which means the cause predates the
  deploy.
- The database is implicated and the fix requires a schema or capacity change.
- Data loss is suspected, as opposed to failed requests that clients can retry.
