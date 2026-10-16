# Incident: dependency outage

An external dependency this service needs is unavailable, degraded, or
untrustworthy: Horizon, PostgreSQL, the secret manager, or the Soroban RPC used
for anchoring.

Availability failures are covered by the alert runbooks
([database health](../runbooks/database-health.md),
[Horizon sync lag](../runbooks/horizon-sync-lag.md)). This document adds what
those do not: the security decisions an outage forces, and the case where the
dependency is not down but compromised.

## Severity

| Situation | Severity |
|---|---|
| The secret manager is unreachable, so credentials cannot be rotated during another incident | **S1** — it blocks containment |
| A dependency is compromised or returning attacker-controlled data | **S1** |
| PostgreSQL is unavailable | **S2** — a full outage, but no data at risk |
| Horizon is unavailable or lagging | **S2** if payment sync is stale enough to affect proof correctness, otherwise **S3** |
| Soroban RPC unavailable, anchoring optional | **S3** |

## Detect

Distinguish three states before choosing an action, because their responses are
different and the first two are indistinguishable from the metrics alone:

1. **Down** — connections fail. Loud, and the alert runbooks cover it.
2. **Degraded** — slow or partial. Timeouts and retries dominate; throughput
   collapses without an obvious error.
3. **Lying** — responding successfully with wrong data. Silent, and the only
   one that is a security incident.

- **Horizon.** `horizon_sync_lag_seconds` and
  `horizon_sync_runs_total{job_result}` say down or degraded. The fault
  classifier in
  [`src/stellar/horizon-fault.ts`](../../src/stellar/horizon-fault.ts) already
  separates retryable transport failures from responses that are wrong, and the
  suite in [`horizon-fault.spec.ts`](../../src/stellar/horizon-fault.spec.ts)
  pins the classification. A rise in non-retryable faults, rather than timeouts,
  is the signal that Horizon is answering incorrectly rather than slowly.
- **PostgreSQL.** `database_probes_total` and `database_probe_duration_ms`; the
  health endpoint reports the probe result.
- **Secret manager.** Failure usually shows up as a restart that will not come
  back, since configuration is validated at start-up
  ([`src/config/env.validation.ts`](../../src/config/env.validation.ts)). Do not
  work around it by pasting secrets into an environment by hand.
- **Compromise, rather than outage.** Look for correctness, not availability: a
  payment sync that ingests operations that do not exist on other Horizon
  instances; a proof status from the registry contradicting the chain.

## Contain

### 1. Stop consuming a dependency that may be lying

For Horizon, this means stopping payment ingestion; for the registry, disabling
anchoring with `CONTRACT_ANCHORING_ENABLED=false`. Ingesting attacker-controlled
data writes records that must be reconciled later, and a bad record that becomes
the basis of an income proof is expensive to undo.

Stopping ingestion is safe: the sync is incremental and resumes from where it
stopped. Continuing while unsure is what is not safe.

### 2. Fail closed, or degrade?

- **Verification** is read-only and depends on the database. If the database is
  down, verification is down; there is nothing safe to serve from a stale cache,
  since the whole answer is "is this credential still valid *now*".
- **Issuance** with `CONTRACT_ANCHORING_REQUIRED=true` fails while anchoring is
  unavailable. That is the configured intent — do not switch it to `false` to
  restore issuance during an incident without recording the decision, because
  the proofs issued in that window are unanchored and there is no marker in the
  data saying which ones they were.
- **Payment sync** may lag safely. A stale payment set makes new proofs
  conservative, not wrong.

### 3. Do not weaken a control to route around an outage

The failure mode to avoid is a temporary bypass that outlives the incident:
turning off SSRF checks to reach a webhook endpoint, or relaxing rate limits to
clear a queue. If a control genuinely must be relaxed, write down when it will
be restored, in the incident log, before relaxing it.

## Preserve evidence

- The dependency's own status page or provider incident identifier, with
  timestamps. It is what makes the timeline defensible later.
- Fault classification counts from the Horizon client — retryable versus
  non-retryable — over the window, rather than raw error text, which can carry
  URLs and identifiers.
- The configuration in force during the outage, especially anything relaxed, and
  when it was restored.
- For a suspected compromise: the divergent responses, captured as a description
  and a hash rather than as pasted payloads, plus the same query issued against
  an independent instance.

## Recover

1. Confirm the dependency is healthy from our side, not only on its status page.
2. Re-enable ingestion and anchoring, then watch the drain: sync lag falling,
   backlog draining, probe latency back to baseline.
3. **Reconcile.** This is the step most often skipped, and the one that matters:

   - **Payments.** Re-sync the window that was missed and confirm the ingested
     operations match Horizon now. Ingestion is idempotent per operation, so a
     re-sync over an overlapping window is safe.
   - **Anchoring.** Every proof issued while anchoring was unavailable needs an
     anchor. Follow [anchoring-failure.md](anchoring-failure.md) to enqueue and
     verify them.
   - **Webhooks.** Deliveries queued during the outage retry on their own;
     confirm the queue drains rather than exhausting attempts
     ([runbook](../runbooks/webhook-delivery.md)).
   - **If the dependency was lying**, records written from its responses are
     suspect. Identify them by ingestion window, verify each against a trusted
     source, and correct them through the normal service paths so the correction
     is audited.

4. Restore every control that was relaxed, and confirm it by test rather than by
   memory.

## Communicate

- To users, an availability statement: what was unavailable, for how long, and
  that no data was lost or exposed — once that is established.
- To integrators, whether webhook deliveries were delayed and whether they need
  to replay anything.
- If the dependency was compromised rather than down, that is a
  [data exposure](data-exposure.md) as well, and its communication rules apply
  instead of these.

## Exit criteria

- The dependency is healthy and has stayed healthy for at least one alert
  window.
- Sync lag, anchoring backlog, and webhook queue are all back to baseline.
- Reconciliation is complete: no gap in ingested payments, no unanchored proofs
  from the outage window, no records left from an untrusted response.
- Every relaxed control is restored, verified, and recorded.
- If issuance ran unanchored, the affected proofs are identified and anchored,
  or their holders are told.
