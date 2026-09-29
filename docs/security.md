# Security

This document collects the security-relevant properties of the backend and
points to the operational runbooks that cover them in detail.

## Secrets

Three application secrets are validated at startup
(`src/config/env.validation.ts`) and never logged or echoed in error
messages:

| Secret | Purpose |
|---|---|
| `SESSION_SECRET` | Configuration presence check for the session subsystem (sessions themselves are opaque, server-side tokens hashed into Postgres — see the runbook for why this changes rotation risk). |
| `CREDENTIAL_SIGNING_SECRET` | HMAC-SHA256 signing/verification of issued credentials and proofs. |
| `PAYMENT_ENCRYPTION_KEY` | AES-256-GCM encryption of indexed payment amounts and webhook secrets at rest. |

An invalid or missing value for any of these fails the process at startup,
before it begins listening, rather than degrading silently at request time.

## Secret rotation

See [docs/runbooks/secret-rotation.md](runbooks/secret-rotation.md) for the
full rotation procedure per secret: zero-downtime dual-key strategy,
verification steps, rollback plan, and the emergency (non-zero-downtime)
invalidation path to use when a secret is suspected compromised.

## Related

- [docs/disaster-recovery.md](disaster-recovery.md) — backup/restore
  procedures and how secrets are (and aren't) handled in drill output.
- [docs/data-retention.md](data-retention.md) — retention windows relevant to
  investigating a suspected compromise (audit logs, verification events).
- [docs/webhooks.md](webhooks.md) — webhook signing and delivery, which also
  depends on `PAYMENT_ENCRYPTION_KEY`.
