# Runbook: API latency

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| API latency | p95 `http_request_duration_ms` > 500 ms over 10 min | **P2** | API on-call |
| API latency severe | p99 > 5 s over 5 min | **P1** | API on-call |

Requests are completing, but slowly. The P2 is degradation; the P1 means clients
are hitting their own timeouts, which is functionally an outage even though the
service reports success.

**Rationale for the windows.** Ten minutes on the P2 avoids paging for a GC pause
or a single slow batch. Five minutes on the P1 is short because at p99 > 5 s the
user impact is already real.

## Diagnose

### 1. One route or all?

```
histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_ms_bucket[5m])))
```

- **One route** → an expensive query or a new code path on that handler.
- **All routes** → shared resource: database, connection pool, CPU, or memory.

### 2. Check the database

```
histogram_quantile(0.95, database_probe_duration_ms)
```

The probe is a trivial `SELECT 1`. If *that* is slow, the problem is the database
or the pool, not application code. Go to [database-health.md](database-health.md).

### 3. Are errors also elevated?

```
rate(http_requests_total{status_class="5xx"}[5m])
```

Latency plus errors usually means saturation — requests queue, then time out.
Latency alone usually means a specific slow operation.

### 4. Is traffic up?

```
sum(rate(http_requests_total[5m]))
```

If volume rose proportionally, this is capacity, not a regression. If latency
rose while volume held flat, something changed in the code or the data.

### 5. Did something deploy?

Correlate onset with the release timeline. A new N+1 query or a missing index on
a grown table both present exactly this way.

## Mitigate

| Cause | Action |
|---|---|
| Slow query on one route | Identify it, add the index, or bound the result set. |
| Connection pool exhausted | Raise the pool size if the database has headroom; otherwise reduce concurrency. |
| Traffic growth | Scale horizontally. Tighten rate limits if one client dominates. |
| Bad deploy | Roll back. |
| Upstream Horizon slowness | Only affects sync and proof paths. Confirm against Horizon latency before treating it as local. |

## Verify

- p95 back under 500 ms, p99 under 2 s, held for 15 minutes.
- Database probe p95 back under 50 ms.
- Error rate has not risen — a fix that trades latency for failures is not a fix.

## Escalate

- p99 stays above 5 s for more than 30 minutes.
- The fix requires a schema migration or an index on a large table.
- Latency is upstream and outside the team's control; switch to communication.
