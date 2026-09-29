# Incident: anchoring failure

The on-chain anchor and the database disagree, or the account that writes
anchors is compromised.

A backlog that is merely slow is not an incident: proofs remain valid and
verifiable through the API while they wait, and
[the anchoring backlog runbook](../runbooks/anchoring-backlog.md) covers it. This
document is for the cases where the chain says something *different* from what
we say, or where someone else can write to the chain as us.

## Severity

| Situation | Severity |
|---|---|
| The anchoring source account or `STELLAR_CLI_SOURCE` credential is compromised | **S1** |
| A proof is revoked locally but shows valid on chain, or vice versa, and the reconciler cannot repair it | **S2** |
| Anchors were written for the wrong proofs, or duplicated | **S2** |
| Backlog growing with `CONTRACT_ANCHORING_REQUIRED=true`, so issuance is failing | **S2** |
| Backlog growing with anchoring optional | **S3** — the runbook, not this document |

## Detect

The reconciler is the detector. It runs every five minutes over proofs with a
confirmed transaction, compares local status against
`getProofStatus` on chain, and repairs what it safely can:

| Local | On chain | Reconciler |
|---|---|---|
| `ACTIVE` | revoked | Repairs: marks local `REVOKED`, logs at `warn` |
| `REVOKED` | not revoked | Repairs: re-enqueues a `REVOKE` intent |
| `ACTIVE` | not valid, not revoked | **Cannot repair.** Logs at `error` and writes a `FAILED` intent with `permanentError = true` |

That last row is the incident: an anchor exists that neither agrees with us nor
explains itself.

```sql
-- Read-only. Intents parked for human attention.
SELECT "operation", "status", count(*), min("createdAt"), max("updatedAt")
FROM "AnchoringIntent"
WHERE "permanentError" = true
GROUP BY 1, 2
ORDER BY 3 DESC;
```

```sql
-- Read-only. Are proofs stuck mid-flight? PROCESSING rows older than the
-- reconciler's five-minute reset window mean nothing is resetting them.
SELECT "status", count(*), min("lastAttemptAt")
FROM "AnchoringIntent"
WHERE "status" IN ('PENDING', 'PROCESSING')
GROUP BY 1;
```

Confirm the reconciler itself is alive before believing its silence:
`rate(job_runs_total{job="anchoring_reconciler"}[15m])`. A reconciler that is not
running produces exactly the same absence of findings as a healthy chain.

For a suspected compromise of the signing account, the authority is the chain,
not this database: check the account's transaction history for operations this
service did not enqueue. Every anchor we wrote has a matching
`AnchoringIntent.transactionHash`.

```sql
-- Read-only. Transaction hashes this service believes it wrote, for comparison
-- against the account's on-chain history.
SELECT "transactionHash", "operation", "updatedAt"
FROM "AnchoringIntent"
WHERE "status" = 'CONFIRMED'
  AND "updatedAt" > now() - interval '7 days'
ORDER BY "updatedAt" DESC;
```

## Contain

### 1. If the signing account may be compromised

Stop writing before investigating. Set `CONTRACT_ANCHORING_ENABLED=false` and
restart: the worker stops dispatching and intents queue as `PENDING`, which is a
recoverable state.

If `CONTRACT_ANCHORING_REQUIRED=true`, disabling anchoring will fail proof
issuance. That is the correct trade during a suspected compromise — issuing
proofs anchored by an attacker-controlled account is worse than not issuing —
but it is an availability decision the incident lead makes explicitly.

Then rotate the source account credential at the key manager and roll
`STELLAR_CLI_SOURCE`. Treat the old credential as
[compromised](compromised-credentials.md).

### 2. If the disagreement is local

Do not hand-edit proof status. `Proof` and `AnchoringIntent` are the evidence
this document depends on, and a manual `UPDATE` is indistinguishable afterwards
from the corruption being investigated. Re-enqueue through the intent table
instead, which is idempotent per `(proofId, operation)`:

```sql
-- DESTRUCTIVE: re-dispatches anchoring for these proofs. Confirm the proof set
-- first with the read-only query above.
UPDATE "AnchoringIntent"
SET "status" = 'PENDING', "permanentError" = false, "nextRetryAt" = now()
WHERE "id" = ANY($1);
```

### 3. If the chain is ahead of us

An on-chain revocation we do not have locally is authoritative — the reconciler
already applies it. Verify it did, rather than repeating it by hand.

## Preserve evidence

- The transaction hashes involved, from `AnchoringIntent`, with their
  `operation`, `status` and timestamps. Hashes are public data and safe to keep
  in the incident store.
- `lastErrorSafe` for the failing intents. It is deliberately the sanitised
  error; do not go looking for the unsanitised one to paste somewhere.
- The reconciler's `error`-level log lines for the affected proofs. They carry
  proof IDs and no key material — proof IDs stay out of the ticket.
- A count of proofs by `(local status, on-chain state)` before any repair, since
  repairs overwrite exactly the state that establishes what happened.
- The anchoring configuration at the time: `CONTRACT_ANCHORING_ENABLED`,
  `CONTRACT_ANCHORING_REQUIRED`, `PROOF_REGISTRY_CONTRACT_ID`.

## Recover

1. Restore anchoring — `CONTRACT_ANCHORING_ENABLED=true` — only after the
   credential is rotated and the account's recent history is understood.
2. Let the queue drain. `anchoring_backlog_size` should fall steadily; a flat
   line means the worker is not running, not that there is nothing to do.
3. **Reconcile.** For every proof touched by the incident, local status and
   on-chain state must agree. The reconciler does this continuously; the exit
   condition is that it finds nothing for a full cycle, not that it ran once.

   ```sql
   -- Read-only. Should return zero rows before closing.
   SELECT count(*) FROM "AnchoringIntent" WHERE "permanentError" = true;
   ```

4. Where an anchor was written by an attacker, revocation on chain is the
   remedy, not deletion — the chain has no delete. Enqueue `REVOKE` for the
   affected proofs and re-issue replacements if the holders still need them.
5. Tell holders whose proofs were revoked and re-issued. A credential that
   silently stops verifying is worse than one whose withdrawal was explained.

## Communicate

- To verifiers and integrators, if verification outcomes shifted: what changed,
  over what window, and whether a proof they accepted has since been revoked.
- To proof holders whose proofs were revoked or re-issued.
- Anchoring is public: transaction hashes and contract identifiers may be shared
  freely. Proof IDs and wallet addresses may not — the mapping from proof to
  person is the part that is private.

## Exit criteria

- No `AnchoringIntent` rows with `permanentError = true`.
- Backlog back to its steady-state size, draining at the normal rate.
- The reconciler completes a full cycle with no repairs and no `error` lines.
- If the account was compromised: the credential is rotated, and every
  unexplained on-chain operation is accounted for and countered.
- Affected holders are notified; the decision log records every intent that was
  re-enqueued by hand and why.
