# Incident: data exposure

Protected data reached somewhere it should not have: another tenant, a log
aggregator, a support ticket, a public endpoint, or a third party.

The protected classes, in the order their exposure matters:

| Class | Where it lives | Why it matters |
|---|---|---|
| Exact amounts | `Payment.amountEncrypted`, `Proof.thresholdEncrypted` | The whole point of the product is proving a threshold *without* revealing the figure |
| Wallet addresses | `User.walletAddress`, `Payment.sourceAddress` | Directly re-identifying, and links a person to an on-chain history |
| Payment history | `Payment` | Employer, cadence, and amount together |
| Credential material | `CREDENTIAL_SIGNING_SECRET`, signatures | Enables forgery, not just disclosure |
| Webhook URLs and secrets | `Webhook` | Customer infrastructure |

## Severity

| Situation | Severity |
|---|---|
| Protected data served to the wrong tenant or to an unauthenticated caller | **S1** |
| Protected data written to a log, ticket, or third-party service | **S1** if it left our systems, **S2** if it is in a system we control and can purge |
| Aggregate or hashed values exposed where identifiers were not | **S3** |

Severity does not fall because the exposure was brief. It falls only when the
data is confirmed to have been unreadable — ciphertext without its key, or a
hash.

## Detect

Exposures arrive as reports, as review findings, or as an anomaly in what an
endpoint returns. Confirm scope before anything else: *what* was exposed, *to
whom*, and *for how long*.

- **Was it ciphertext or plaintext?** Amounts and thresholds are stored
  encrypted, and a leak of `amountEncrypted` without `PAYMENT_ENCRYPTION_KEY` is
  not a disclosure of the amount. Check whether the same incident also exposed
  the key; if it did, treat it as plaintext.
- **Cross-tenant reads.** Organisation scoping is enforced in the query, not by
  a check afterwards. An exposure here means a query lost its filter, so
  identify the endpoint and the deploy that changed it rather than looking for
  one bad request.
- **What did the endpoint actually return?** Response shape is pinned by the
  contract snapshot tests
  ([`src/common/compatibility/`](../../src/common/compatibility/contract-snapshot.ts));
  a field appearing that should not have is visible as a diff there.
- **Logs.** The operational logger redacts known-sensitive fields
  ([`src/common/observability/redaction.ts`](../../src/common/observability/redaction.ts)).
  Exposure through logs usually means a value reached a field the redactor does
  not know about. Establish which log sinks received it and their retention.

## Contain

### 1. Stop the leak

- **A code path** — roll back the deploy that introduced it. Rolling back is
  faster than fixing forward and does not need the fix to be right first time.
- **An endpoint that cannot be rolled back** — disable the route or the feature
  and accept the outage; a broken feature is preferable to a continuing
  disclosure.
- **A log sink** — stop shipping to it before purging it. Purging a sink that is
  still receiving is not containment.

### 2. Cut access to the copy

For an exposure into a system we control, restrict access to the copy while
purging is arranged. For a third-party system, the request to delete goes
alongside the notification, and the incident does not close on their promise —
it closes on their confirmation.

### 3. Revoke what the exposure enables

If credential material was exposed, continue with
[compromised credentials](compromised-credentials.md); those steps come first,
because forgery is worse than disclosure.

## Preserve evidence

Evidence collection here must not multiply the exposure. That constraint drives
every rule below.

- **Do not copy exposed data into the incident record.** Record its *shape* and
  *scale*: "responses for 3 payments belonging to another organisation, over 14
  minutes". Never a sample row, and never a redacted-looking sample either.
- **Reference by identifier, not content.** Row counts, organisation
  identifiers, and time ranges are enough to reconstruct scope later under
  normal access controls.
- **Keep the access logs that establish who saw it**, in the incident store, not
  the ticket.
- **Preserve the diff that caused it**: the commit, the deploy time, and the
  contract snapshot difference if there is one.
- **Record the encryption status**, because it is the difference between a
  disclosure and a non-event, and it is the first thing a reviewer will ask.

## Recover

1. Ship the fix, with a test that fails without it. An exposure whose regression
   test does not exist will happen again.
2. Purge copies: log sinks, caches, tickets, and any third-party system that
   received it. Record each as requested and confirmed, separately.
3. **Reconcile the data.** Establish which records were exposed and confirm they
   are otherwise intact — an exposure through a query bug can be accompanied by
   a write bug. For payments and proofs, compare row counts and per-tenant
   ownership against the period before the change.
4. Rotate anything the exposure could have compromised.
5. Consider whether affected users need something beyond notification: a proof
   revoked and re-issued, an integration re-keyed.

## Communicate

- **Affected tenants and users**, once the scope is established: what data, over
  what window, who could see it, what has been done, and what they should do.
- **Regulatory or contractual notification** is a maintainer decision, taken
  with the scope statement in hand, not from the incident channel.
- The communication states the encryption status plainly. "Encrypted values were
  exposed; the key was not" is materially different from "amounts were exposed",
  and being vague about which one it was reads as concealment.

## Exit criteria

- The leaking path is fixed and covered by a test.
- Every copy is purged, or its retention is documented with an end date.
- Scope is written down: what, whose, how many, how long, to whom.
- Affected parties are notified; any regulatory decision is recorded with its
  reasoning.
- Data integrity is confirmed by reconciliation, not assumed.
- The postmortem explains why the boundary failed, not only which line was
  wrong.
