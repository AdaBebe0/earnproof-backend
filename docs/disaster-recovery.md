# Disaster Recovery Runbook

Database durability is not complete until maintainers can restore proof
lifecycle, revocation, anchoring, API-key, and webhook state **coherently** after
loss.

The word doing the work there is *coherently*. A restore that produces the right
number of rows in every table can still be wrong — and the specific way it goes
wrong is dangerous: if proofs are restored from a later snapshot than the
revocations that withdraw them, the system will confidently verify credentials
their issuers already revoked. That reports success. It is worse than a restore
that visibly fails.

## Recovery objectives

| Objective | Target | Bounded by |
|---|---|---|
| **RPO** (max data loss) | 60 minutes | Backup frequency |
| **RTO** (max time to restore) | 240 minutes | Provisioning + restore + verification |

These are targets, not guarantees. They hold only if the drill in this document
is run and passes; an untested backup has an unbounded RTO, because nobody knows
whether it works.

## Who may initiate a restore

| Target | Who | Additional requirement |
|---|---|---|
| Local / disposable | Any contributor | None |
| Shared staging | Any maintainer | Announce in the team channel first |
| **Production** | Two maintainers from `MAINTAINERS.md` | Written incident record, second maintainer confirms the target |

Production requires two people because the failure mode is unrecoverable: a
restore overwrites everything in the target, so a restore aimed at the wrong
database destroys the very data the backup exists to protect. Two-person control
is cheap relative to that.

## Prerequisites — external, never in the backup

The backup contains **ciphertext only**. Three encrypted columns exist:
`Payment.amountEncrypted`, `Proof.thresholdEncrypted`, and
`Webhook.secretEncrypted`.

The keys that decrypt them are **not in the backup and must never be**. A backup
carrying its own decryption key reduces to an unencrypted backup the moment it is
copied anywhere — and backups get copied to laptops, object storage, and support
tickets.

Before any restore, confirm you have:

| Prerequisite | Source | Notes |
|---|---|---|
| Backup archive | Object storage | Encrypted at rest |
| Decryption key | External key manager | Referenced by `encryptionKeyId`, never embedded |
| `PAYMENT_ENCRYPTION_KEY` | Secret manager | Without it, restored amounts are unreadable |
| `CREDENTIAL_SIGNING_SECRET` | Secret manager | Without it, new credentials cannot be signed |
| `SESSION_SECRET` | Secret manager | Existing sessions invalidate if rotated |
| Target database | Provisioned, empty | Must be at a known migration |

**If the key manager was lost in the same incident, the encrypted columns are
unrecoverable.** Say this out loud during planning: it means key-manager
durability is a separate requirement from database durability, and a DR plan that
only backs up the database has not actually protected the data.

## Point-in-time limitations

Be explicit about what a restore can and cannot recover:

- **Up to 60 minutes of writes may be lost** (the RPO). Proofs issued in that
  window are gone from the database while their on-chain anchors persist —
  see reconciliation below.
- **On-chain state does not roll back.** The Stellar ledger is append-only. A
  restore rewinds the database only, so the database and chain will disagree
  until reconciled.
- **Webhook deliveries in flight are lost.** Integrators may have received an
  event the restored database has no record of sending.
- **API keys created in the lost window stop working**, with no notice to their
  owners.
- **Sessions do not survive** if `SESSION_SECRET` was rotated as part of the
  incident response.

## Post-restore reconciliation

Required, in this order. Steps 1–2 are the ones that matter most.

1. **Reconcile anchoring against chain.** The anchoring reconciler compares local
   proof state against on-chain state. Proofs anchored in the lost window exist
   on-chain but not locally; proofs revoked in the lost window are locally
   ACTIVE but revoked on-chain. Run it before accepting traffic — this is the
   step that closes the "verifies a revoked credential" gap.
2. **Re-verify revocation coherence.** Confirm no proof with a revocation record
   restored in a non-`REVOKED` state. The drill checks exactly this.
3. **Replay failed webhook deliveries.** Deliveries pending at backup time need
   re-queueing; integrators may see duplicates, which is why envelopes carry an
   idempotency key.
4. **Audit API keys.** Keys issued in the lost window are absent. Notify affected
   organizations through the support channel — not by inspecting usage telemetry.
5. **Record the gap.** Write the actual RPO achieved into the incident record.

## Running the drill

The drill is **non-destructive by default** and refuses an unapproved target.

```bash
npm run drill:verify
```

This validates the manifest format, confirms the drill accepts a coherent
restore, and — importantly — confirms it **rejects** an incoherent one. A drill
that cannot fail proves nothing, so the dry-run includes that negative control.

Full drill tests:

```bash
npx jest src/testing/recovery --runInBand
```

### Against a real dump

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/drill_target"
export NODE_ENV=test
npx prisma migrate deploy
# restore the dump into the target, then verify
npx jest src/testing/recovery --runInBand
```

Restoring to a non-disposable host requires the explicit token
`I_UNDERSTAND_THIS_OVERWRITES_DATA`. A boolean flag was deliberately not used —
a boolean can be set by a stray environment variable, whereas a specific phrase
has to be typed on purpose.

## What the drill verifies

| Check | Failure it catches |
|---|---|
| Migration parity | Restoring into a different schema — silent corruption |
| Row counts | Truncated dump |
| Per-domain checksums | Content drift that row counts cannot see |
| Revocation coherence | A revoked proof restored ACTIVE — the dangerous one |
| Anchoring references | Orphaned intents pointing at absent proofs |
| Secret scanning | A manifest or report carrying credentials |

All five required domains must be present: `proof_lifecycle`, `revocation`,
`anchoring_intent`, `api_keys`, `webhooks`.

The drill reports **every** finding rather than stopping at the first, because an
operator mid-incident needs the whole picture, not one problem per run.

## Secrets in drill output

Manifests and drill output travel into runbooks, tickets, and CI logs — contexts
far more widely readable than the environment that produced them. So:

- Manifests reference an `encryptionKeyId`; they never carry key material. The
  identifier is not itself a secret; the key is.
- Manifest validation scans for private key blocks, credentialed database URLs,
  password fields, and cloud access keys, at any nesting depth. Serialising and
  pattern-matching catches a secret in a field added after the check was written,
  which a field-by-field check would miss.
- Refusal messages never echo the database password.

## Backup procedure

```bash
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > backup.dump
```

Then, separately:

1. Encrypt the dump with the key manager. Record the **key identifier** in the
   manifest, never the key.
2. Record the current migration:
   `npx prisma migrate status` — the manifest's `migrationVersion` must match, or
   the restore is into a schema the dump did not come from.
3. Record per-domain row counts and checksums.
4. Upload to object storage with versioning and a retention policy.

Backups run hourly to satisfy the 60-minute RPO.

## Scheduled verification

`.github/workflows/backup-drill.yml` runs the dry-run weekly and on any change to
the drill or runbook.

The weekly cadence exists because this failure is slow: the manifest format and
the drill logic drift apart over months, and nobody notices until a real restore
is needed.

### Stated limitation

**The CI drill does not prove production backups restore.** It runs against a
synthetic fixture with no database, and proves only that the format and the drill
logic still agree.

Proving restorability requires a rehearsal against a real dump in a disposable
environment. That is a quarterly manual exercise, and it is deliberately not
automated here: doing it properly needs production-shaped data volumes and real
key-manager access, and wiring either of those into CI would create a larger
security problem than the one it solves.

## Quarterly rehearsal checklist

- [ ] Provision a disposable target
- [ ] Retrieve the most recent production backup
- [ ] Retrieve decryption keys from the key manager (confirm access **before**
      you need it)
- [ ] `npx prisma migrate deploy`; confirm the migration matches the manifest
- [ ] Restore the dump
- [ ] Run `npx jest src/testing/recovery --runInBand`
- [ ] Verify a known proof verifies correctly
- [ ] Verify a known revoked proof is rejected
- [ ] Run anchoring reconciliation; record discrepancies
- [ ] Record actual RTO against the 240-minute target
- [ ] Destroy the target
- [ ] File findings; open issues for anything that surprised you
