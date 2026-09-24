# Forensic preservation

What to collect during an incident, how to keep it intact, and what must never
be copied while collecting it.

The tension this document resolves: evidence is most useful when it is detailed,
and this service's privacy design exists precisely to stop detail accumulating.
Both survive if evidence is collected by *reference* — counts, hashes,
identifiers, time ranges — rather than by copying records.

## What counts as evidence here

| Source | Holds | Notes |
|---|---|---|
| `AuditLog` | Authenticated mutations: actor, action, resource, tenant | Fails closed on write, so absence of a row means the mutation did not happen |
| `AuthAuditEvent` | Authentication attempts, hashed wallet and client | Fails open: a gap is inconclusive, not exculpatory |
| `VerificationEventLog` | Verification outcomes, salted metadata hash | Fails open, same caveat |
| `AnchoringIntent` | Anchoring attempts, transaction hashes, sanitised errors | Transaction hashes are public |
| Structured application logs | Correlation identifiers, workflow labels, redacted fields | Retention set by the log platform, usually shorter than the incident |
| Edge and load-balancer logs | IP addresses, user agents | Identifying: the service deliberately keeps none of this |
| Metrics | Rates and counts | Lowest-risk evidence; prefer it wherever it answers the question |

The best-effort column matters in an investigation. The authentication and
verification paths swallow an audit write failure rather than refusing the
request — availability wins on unauthenticated paths — so a gap in those two
stores is inconclusive. `AuditLog` writes fail the mutation instead, so its
absence of a row does support the claim "this did not happen".

## Collect before you contain

Containment overwrites evidence. Revoking a key sets `revokedAt`; re-enqueuing
an anchoring intent overwrites the state that showed the disagreement;
restarting drops in-memory state and can roll logs.

Order of operations:

1. **Snapshot the counts** that establish scope. Cheap, fast, and enough to
   reconstruct scope later.
2. **Note the clock.** Record the wall-clock time of the first containment
   action, so every later comparison has a boundary.
3. **Contain.**
4. **Snapshot again**, so before-and-after is a fact rather than a memory.

At S1 the sequence compresses: contain first, and accept the evidence loss. The
loss is smaller than it feels — the audit trail is already written and survives
revocation.

## Integrity

- **Do not mutate the source.** Never `UPDATE` a row to annotate it, and never
  delete "noise". Retention jobs run on a schedule
  ([data retention](../data-retention.md)); if an incident window is at risk of
  being swept, set `RETENTION_DRY_RUN=true` to pause disposal rather than
  editing anything.
- **Record how each artefact was produced.** The exact query, the time it ran,
  the environment, and who ran it. An artefact whose provenance is unknown is
  not evidence.
- **Hash what you export.** Record the SHA-256 of each exported file alongside
  it, so a later reader can tell whether it changed.
- **Keep it in one place**, with access limited to the responders. Not in the
  ticket, not in chat, not on a laptop.
- **Chain of custody.** Who collected it, when, who has accessed it since. Three
  lines in the incident log is enough.

## Privacy rules while collecting

These are not softer during an incident. An incident is when they are most often
broken, and an incident channel is more widely readable and longer retained than
almost anything else.

**Never place in a ticket, chat message, or postmortem:**

- a wallet address, a proof ID, or a credential hash;
- an amount, a memo, or any payment detail;
- a webhook URL or an API key prefix belonging to a named customer;
- a secret, current or rotated;
- raw error text or a stack trace that has not been redacted;
- a sample row "for illustration", redacted or not.

**Use instead:**

- counts and rates: "412 verifications returned `UNKNOWN` in 20 minutes";
- correlation and request identifiers, which are opaque by construction;
- hashed values the system already stores hashed — `walletHash`,
  `clientMetadataHash` — which are safe to quote and are enough to group by;
- organisation identifiers where the tenant, not the person, is the subject;
- time ranges, which are usually the missing piece anyway.

If the investigation genuinely needs record detail, query the database under
normal access controls and keep the result in the incident store. That access is
itself audited, and it should be.

## Retention of evidence

- Keep incident evidence only as long as the investigation and any disclosure
  obligation require, then dispose of it deliberately and record that you did.
- Evidence containing identifying data — edge logs above all — gets the shortest
  retention that still serves the investigation.
- Do not let evidence become a permanent second copy of protected data. That is
  the failure this whole document exists to prevent: an incident about exposure
  should not create a new, less-guarded store of exactly what was exposed.

## Working set

A useful evidence set for most incidents is small:

- the incident timeline, with the containment boundary marked;
- audit counts by event type and outcome, before and after containment;
- the relevant metric series over the window, exported as an image or a CSV of
  aggregates;
- the deploy or configuration change implicated, by commit;
- the decision log: what was chosen, by whom, and why.

If it will not fit on one page, the extra is probably detail that should have
stayed in the database.
