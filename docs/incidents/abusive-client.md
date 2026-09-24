# Incident: abusive client

A client is using the API in a way that harms the service or other tenants:
authentication brute force, verification flooding, scraping, or a stuck
integration retrying without backoff.

Abuse and a broken integration look identical from the metrics. They are treated
the same way until the volume stops; the difference only changes who is
contacted afterwards.

## Severity

| Situation | Severity |
|---|---|
| Abuse is degrading the API for other tenants — 5xx rate or latency alerts firing alongside it | **S2** |
| Sustained authentication brute force against one wallet, or credential stuffing across many | **S2** |
| Verification flooding, service still healthy | **S3** |
| Scraping within rate limits | **S3**, hygiene |

Escalate to S1 if the abuse is succeeding at anything: a rising count of
successful authentications from the same client fingerprint, or protected data
being returned where it should not be — that is a
[data exposure](data-exposure.md).

## Detect

Start with the API alerts ([availability](../runbooks/api-availability.md),
[latency](../runbooks/api-latency.md)). Abuse presents there first; these steps
say whether the load is adversarial.

- **Authentication pressure.** The rate limiter records every refusal.

  ```sql
  -- Read-only. Refusals versus attempts over the window.
  SELECT "eventType", "success", count(*)
  FROM "AuthAuditEvent"
  WHERE "createdAt" > now() - interval '1 hour'
  GROUP BY 1, 2
  ORDER BY 3 DESC;
  ```

  A large `RATE_LIMITED` count means the limiter is working. A large
  `SIGNATURE_INVALID` count with few `RATE_LIMITED` means attempts are spread
  across wallets and each one stays under the per-wallet limit — credential
  stuffing rather than brute force against one account.

- **Concentrated or spread?** Both the wallet and the client fingerprint are
  stored hashed, which is enough to count without identifying:

  ```sql
  -- Read-only. Are failures concentrated on one hashed client?
  SELECT "clientMetadataHash", count(*) AS attempts,
         count(*) FILTER (WHERE NOT "success") AS failures
  FROM "AuthAuditEvent"
  WHERE "createdAt" > now() - interval '1 hour'
    AND "clientMetadataHash" IS NOT NULL
  GROUP BY 1
  ORDER BY attempts DESC
  LIMIT 20;
  ```

- **Verification flooding.** Verification is public and unauthenticated by
  design ([ADR 0004](../adr/0004-public-unauthenticated-verification.md)), so
  volume alone is not abuse. Read `verifications_total` by outcome: a flood of
  `UNKNOWN` is someone probing for proof identifiers, which is very different
  from a flood of `VALID`.

- **One integration or many?** `api_key.authenticated` rows carry the key prefix
  and organisation, so a runaway integration can be attributed without reading
  request logs.

## Contain

Least-damaging measure first. Every step here affects legitimate traffic to some
degree; say which one you chose and why.

### 1. Let the existing limits work

Authentication is already limited per hashed wallet and per hashed client
fingerprint, configured by `AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS`,
`AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS`,
`AUTH_RATE_LIMIT_MAX_VERIFICATIONS` and
`AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS`. If refusals are climbing and the API
is healthy, the correct action is often none: the control is doing its job and
tightening it costs real users.

### 2. Tighten the limits

Lower the maxima, or shorten the windows, and restart. This affects every
client, so record the values before and after, and set a time to restore them.
Limits that stay at incident levels become the accidental product behaviour.

### 3. Revoke the credential, if the abuse is authenticated

An API key hammering the service is contained by revoking it —
`DELETE /api/v1/api-keys/:id` — which takes effect on the next request
and is audited. For a session, `SessionService.revokeAll(userId)`.

### 4. Block upstream

Unauthenticated abuse — verification flooding, or authentication attempts across
many wallets — cannot be attributed to a credential and must be handled at the
edge: the load balancer, WAF, or CDN in front of the service. This service
deliberately keeps no raw IP addresses, so it cannot block by address and cannot
tell you which address to block. That information comes from the edge's own
logs.

This is the trade the privacy design makes: the service is not the place where
network-level abuse is stopped.

### 5. Shed load

If the API is failing for everyone, protect writes before reads: proof issuance
and payment sync matter more than verification throughput. Scaling out is
usually faster than tuning under pressure.

## Preserve evidence

- Counts, not requests: attempts, failures, and refusals per window, taken from
  `AuthAuditEvent` and the metrics.
- The hashed client fingerprints and hashed wallets involved, which are already
  non-identifying and safe to keep in the incident record.
- The edge logs, if a block was placed there. These *do* contain IP addresses,
  so they live in the incident store under the same handling as any other
  identifying evidence — see
  [evidence-preservation.md](evidence-preservation.md) — and never in the
  ticket.
- The limiter configuration before any change, so the restore is unambiguous.

## Recover

1. Restore any limits that were tightened, at the time recorded in the decision
   log.
2. Remove edge blocks that were meant to be temporary. An unreviewed block list
   is an outage waiting for the client that changed address.
3. Check whether the abuse succeeded at anything: successful authentications
   from the fingerprint, mutations in `AuditLog` by the affected actor. Any
   success reclassifies this as a
   [compromised credential](compromised-credentials.md) incident.
4. If the cause was a customer integration, tell them what it did and what it
   must change.

## Communicate

- To other tenants, only if they were degraded: what was slow or failing, for
  how long, and that no data was exposed — once that is established.
- To the responsible customer, if identified: what their client did, what was
  limited or revoked, and what they must change to be re-enabled.
- Nothing that names another tenant, and no wallet addresses.

## Exit criteria

- Request volume and error rate are back to baseline, held for at least the
  alert's own window.
- Temporary limits and edge blocks are reverted, or converted into a deliberate,
  reviewed change.
- The abuse is confirmed to have succeeded at nothing, or the follow-on incident
  is open.
- If a control was missing, an issue exists for it — not a note in the
  postmortem.
