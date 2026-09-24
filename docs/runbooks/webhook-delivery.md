# Runbook: Webhook delivery

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Webhook failure rate | `webhook_deliveries_total{outcome!="success"}` > 5% over 15 min | **P2** | Integrations on-call |

Event notifications are not reaching customer endpoints. Integrations relying on
them are operating on stale state, though no EarnProof data is lost — deliveries
are retried and remain queryable.

**Why 5%.** A single flaky customer endpoint sits comfortably below it. Above 5%
the cause is usually ours: signing, egress, or the delivery worker itself.

## Diagnose

### 1. Ours or theirs?

```
sum by (outcome, status_class) (rate(webhook_deliveries_total[15m]))
```

- **`status_class="4xx"`** → endpoints are rejecting us. Often expired customer
  credentials or a signature mismatch.
- **`status_class="5xx"`** → customer endpoints are erroring. Usually theirs.
- **`outcome="timeout"`** → slow endpoints, or our egress is blocked.
- **`outcome="rejected"`** → blocked by the SSRF guard before dispatch. Ours.

### 2. One tenant or many?

The metric deliberately carries no organisation or URL label — either would grow
series count with tenant count, and the URL is customer data. Answer this from
the logs instead, filtered to `workflow=webhooks` over the window.

Concentrated in one tenant → their endpoint. Spread across many → ours.

### 3. Check the SSRF guard

`outcome="rejected"` means delivery never left the process. A configuration
change that narrowed the allowed egress range, or a customer moving to an
address the guard treats as internal, both present this way.

### 4. Check signing

A uniform 4xx across tenants that began at a deployment points at signature
generation. Customers verifying signatures reject every delivery at once.

Confirm before rolling back: `npm run webhook:conformance` replays the frozen
signing vectors against the shipping signer. If it fails, the wire format
changed and every integrator is broken. If it passes, the cause is elsewhere.
See [the verification guide](../webhooks.md) for the scheme itself.

### 5. Is anything being dispatched?

```
rate(webhook_deliveries_total[15m])
```

Zero attempts is a different failure from failed attempts: the dispatcher is not
running. Check `job_runs_total` for the process generally.

## Mitigate

| Cause | Action |
|---|---|
| One customer endpoint down | No action. Retries handle it. Notify the customer if it persists. |
| Signature mismatch after deploy | Roll back. Every integration is broken until it is fixed. |
| SSRF guard over-blocking | Review the configured ranges. Widen only with deliberate security review. |
| Egress blocked at the network | Fix networking. Queued deliveries drain on recovery. |
| Dispatcher not running | Restart; confirm attempts resume. |
| Many endpoints timing out | Check our own egress before concluding it is theirs. |

## Verify

- Failure rate back under 5%, held for 15 minutes.
- `outcome="rejected"` at zero unless deliberately blocking a known-bad endpoint.
- Delivery duration p95 back to baseline.
- Previously failed deliveries have succeeded on retry rather than exhausting
  their attempts.

## Escalate

- Failure rate above 25%, which implies a systemic cause.
- Signing is implicated — every integration is affected simultaneously.
- Deliveries have exhausted their retries, so recovery needs a replay decision.
- A customer escalates about missed events during the window.
