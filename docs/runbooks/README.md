# Runbooks

One runbook per alert in the table in [`docs/observability.md`](../observability.md).

Each follows the same shape so that a responder woken at 3am does not have to
learn a new document structure first:

1. **What fired** — the condition and what it means in user terms.
2. **Severity and owner** — who is expected to respond, and how fast.
3. **Diagnose** — ordered checks, cheapest and most likely first.
4. **Mitigate** — what to do about each cause.
5. **Verify** — how to know it is actually fixed.
6. **Escalate** — when to stop and hand off.

For an incident rather than an alert — a compromised credential, an abusive
client, a data exposure, an anchoring failure, or a dependency outage — see the
[incident runbooks](../incidents/README.md). They cover severity, roles,
evidence preservation, and recovery; the documents here cover a single firing
alert.

## Privacy while responding

The rules that govern metrics govern incident response too.

- Investigate with aggregates and correlation identifiers. Both are safe to
  paste into an incident channel.
- **Never paste a wallet address, proof ID, credential hash, amount, memo,
  webhook URL, or raw error text into a ticket, chat, or postmortem.** Incident
  channels are widely readable and retained far longer than the incident.
- If the diagnosis genuinely requires record detail, query the database directly
  under normal access controls. That step is audited, and it should be.
- Postmortems describe what happened using counts and rates. "412 anchoring
  intents failed permanently" is the right level of detail; a list of proof IDs
  is not.

## Alert index

| Alert | Runbook |
|---|---|
| API 5xx rate, API 5xx spike | [api-availability.md](api-availability.md) |
| API latency, API latency severe | [api-latency.md](api-latency.md) |
| Sync lag, Sync stalled | [horizon-sync-lag.md](horizon-sync-lag.md) |
| Anchoring backlog, Anchoring permanent failures | [anchoring-backlog.md](anchoring-backlog.md) |
| Webhook failure rate | [webhook-delivery.md](webhook-delivery.md) |
| Database probe failure, Database probe latency | [database-health.md](database-health.md) |
| Verification shift | [verification-outcomes.md](verification-outcomes.md) |
| Job failure, Job silent | [job-failures.md](job-failures.md) |
