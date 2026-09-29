# Incident response

Repository-specific steps for security incidents: a compromised credential, an
abusive client, an exposure of protected data, an anchoring failure, or a
dependency outage.

These are not the alert runbooks. [`docs/runbooks/`](../runbooks/README.md)
answers "this alert fired, what is broken?" The documents here answer "something
adversarial or damaging has happened, what do we do, in what order, and what do
we have to preserve while doing it?"

Report a vulnerability, rather than respond to one, through
[`SECURITY.md`](../../SECURITY.md).

## Scenarios

| Scenario | Runbook |
|---|---|
| Leaked session token, API key, signing secret, or database credential | [compromised-credentials.md](compromised-credentials.md) |
| A client abusing the API: scraping, brute force, verification flooding | [abusive-client.md](abusive-client.md) |
| Protected data reached somewhere it should not have | [data-exposure.md](data-exposure.md) |
| Anchoring stalled, mis-anchored, or the signing account compromised | [anchoring-failure.md](anchoring-failure.md) |
| Horizon, PostgreSQL, the key manager, or a dependency is down or compromised | [dependency-outage.md](dependency-outage.md) |

Two supporting documents:

- [evidence-preservation.md](evidence-preservation.md) — what to collect, how to
  keep it intact, and what must never be copied into a ticket.
- [tabletop.md](tabletop.md) — the exercise checklist that keeps these documents
  from rotting.

## Severity

Severity sets response speed and who is woken. Choose it in the first five
minutes from the worst plausible reading of what you know, and revise it out
loud when you learn more. Under-classifying to avoid waking someone is the
common mistake; a severity that drops after ten minutes costs one person ten
minutes.

| Severity | Meaning | Response | Examples |
|---|---|---|---|
| **S1** | Protected data is exposed, or an attacker holds a credential that can issue or alter credentials | Immediate, all hands, incident lead named within 15 minutes | Signing secret leaked; database credential in a public repository; payment amounts served to the wrong tenant |
| **S2** | A credential is compromised but its blast radius is one tenant, or availability of a security control is degraded | Within 1 hour, business hours or on-call | One organisation's API key leaked; rate limiting disabled by a bad deploy |
| **S3** | Abuse or a suspected exposure with no confirmed impact | Next business day | Verification flooding from one source; a scraping client tripping rate limits |
| **S4** | Hygiene: a finding with no live exposure | Tracked as an issue | A secret found in a private branch that never shipped |

Escalate a severity if any of these becomes true: protected data left the
system; an attacker can sign or issue credentials; more than one tenant is
affected; you cannot establish the blast radius within an hour.

## Roles

Small team, so one person often holds several of these. Name them explicitly
anyway — an unnamed role is one nobody performs.

| Role | Owns | First act |
|---|---|---|
| **Incident lead** | Severity, sequencing, the decision log | Opens the incident record, states the severity |
| **Responder** | Containment and recovery actions | Confirms the target environment before every command |
| **Evidence keeper** | Collection, integrity, chain of custody | Snapshots the audit trail before anything is revoked |
| **Communications** | Affected-party and maintainer updates | Drafts nothing until the lead confirms the facts |

The incident lead does not run commands. Someone holding both roles will skip
the decision log under pressure, and the log is what makes the postmortem and
any disclosure possible.

## Decision points

Four decisions recur, all of which trade evidence or availability for
containment. Decide them deliberately, and record the choice.

1. **Revoke now, or observe first?** Revoking destroys the attacker's session
   and, with it, some of what they were doing. Default to revoking at S1 and S2:
   evidence already written to the audit trail survives revocation, and
   `AuthAuditEvent` plus `AuditLog` are the evidence that matters. Observe first
   only when the exposure is bounded, the incident lead says so, and the
   observation window is written down with an end time.
2. **Degrade, or stay up?** Disabling verification protects nothing on its own —
   verification is read-only — but disabling *issuance* stops an attacker
   minting credentials. Prefer stopping writes over stopping reads.
3. **Rotate one secret, or all of them?** Rotate what you can prove was exposed
   plus everything that shared its storage. Rotating `CREDENTIAL_SIGNING_SECRET`
   is not free: see the consequences in
   [compromised-credentials.md](compromised-credentials.md).
4. **Notify now, or when the facts are firm?** Notify affected parties as soon
   as their exposure is established, even if the cause is not. Do not publish a
   cause you have not confirmed.

## Escalating safely

- **Two people for irreversible actions.** Anything that destroys state —
  restoring a database, deleting rows, rotating the payment encryption key —
  needs a second maintainer from [`MAINTAINERS.md`](../../MAINTAINERS.md)
  confirming the target, exactly as
  [disaster recovery](../disaster-recovery.md) requires.
- **Confirm the environment before every command.** Most of the damage done
  during incidents is done by a correct command aimed at the wrong environment.
- **Hand off in writing.** A handoff states: current severity, what has been
  contained, what is still exposed, what evidence exists and where, and the next
  planned action.
- **Do not disclose outside the incident.** Vulnerability details go to
  `security@veridatum.dev`, not to a public issue, until a fix has shipped.

## Evidence, briefly

The full rules are in [evidence-preservation.md](evidence-preservation.md). Two
of them apply to every incident and are worth repeating here:

- **Never paste a secret, a wallet address, a proof ID, an amount, a memo, a
  webhook URL, or raw error text into a ticket or chat.** Incident channels are
  widely readable and retained far longer than the incident. Reference records
  by count, by hash, or by correlation identifier.
- **A rotated secret is still a secret.** Do not paste the old value into the
  incident record to show what leaked. Record where it leaked and when it was
  rotated.

## Shape of each runbook

Every scenario document follows the same order, so nobody has to learn a new
structure mid-incident:

1. **Severity** — how to classify this scenario, and what escalates it.
2. **Detect** — what the alert, log, or report looks like, and how to confirm
   it is real.
3. **Contain** — stop the bleeding, in priority order.
4. **Preserve evidence** — what to collect, before and after containment.
5. **Recover** — restore normal operation, including any data reconciliation.
6. **Communicate** — the facts the communications role needs, and where they
   come from.
7. **Exit criteria** — what must be true before the incident is closed.
