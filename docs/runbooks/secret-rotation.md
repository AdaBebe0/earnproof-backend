# Runbook: Secret rotation

Covers the three application secrets validated at startup by
`src/config/env.validation.ts` and consumed via `ConfigService` in
`src/config/configuration.ts`:

| Secret | Env var | Where it's read | What it protects |
|---|---|---|---|
| Session secret | `SESSION_SECRET` | `src/auth/session.service.ts` | Presence check only — see [SESSION_SECRET](#session_secret) |
| Credential signing secret | `CREDENTIAL_SIGNING_SECRET` | `src/credentials/credentials.service.ts`, `src/proofs/proofs.service.ts` | HMAC-SHA256 signature over issued credentials/proofs |
| Payment encryption key | `PAYMENT_ENCRYPTION_KEY` | `src/webhooks/webhooks.service.ts`, `src/webhooks/webhook-delivery.service.ts`, `src/proofs/proofs.service.ts`, `src/common/crypto/protected-amount.ts` | AES-256-GCM encryption of indexed payment amounts and webhook payload secrets |

All three are validated at startup (non-empty, minimum length, and — for the
encryption key — correct decoded byte length) by `validateEnv()`. An invalid
or missing value fails the process before it starts listening; see
[docs/security.md](../security.md) for the broader secret-handling posture.

**Deployment context.** The app runs from a single `.env`-style set of
environment variables (see `.env.example` and `docker-compose.yml`) — there is
no in-repo secret-manager integration today. The steps below are written
generically so they work whether secrets are injected via a platform's env-var
UI, a `.env` file rendered by CI/CD, or a secret manager (AWS Secrets Manager,
HashiCorp Vault, GCP Secret Manager, etc.) that populates the process
environment before `node dist/main.js` starts. Wherever a step says "update
the secret," substitute your own mechanism — updating the secret-manager
entry and redeploying, or editing `.env` and restarting the container(s).

---

## SESSION_SECRET

### How it's actually used

Sessions are **server-side and opaque**, not JWTs. `SessionService.create()`
generates `<sessionId>.<32 random hex bytes>`, stores only
`sha256(token)` in the `AuthSession` table, and returns the raw token to the
client as a Bearer token. `SESSION_SECRET` is read once at construction
(`configService.getOrThrow("sessionSecret")`) purely to confirm the variable
is configured — it is **not** used to sign or derive the token. Token
confidentiality comes entirely from the 32 bytes of randomness, and
`AuthSession.tokenHash` is what's checked on every request
(`SessionService.validate()`).

This matters for rotation: because no session's validity depends on the
*value* of `SESSION_SECRET`, rotating it never invalidates existing sessions
and never requires a "dual-key" acceptance window in the way a JWT-signing
secret would.

### Rotation procedure (zero downtime)

1. Generate a new value: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Update `SESSION_SECRET` in the secret store / environment for all
   replicas.
3. Roll the deployment (rolling restart, one replica at a time). Because
   existing sessions are validated against `AuthSession.tokenHash` in
   Postgres — not against `SESSION_SECRET` — replicas running the old value
   and replicas running the new value can serve requests simultaneously
   without any session being rejected. There is no dual-key logic to
   implement here; the token hash lookup already makes both old and new
   process generations consistent.
4. Confirm every replica picked up the new value (see Verification below),
   then remove the old value from the secret store.

**Timeline estimate:** 10–20 minutes — dominated by the rolling restart, not
by any migration or grace period, since there is nothing to keep valid across
the change.

### Verification

- `GET /api/v1/health` returns `ok` on every replica after restart (confirms
  `validateEnv()` accepted the new value — a missing/empty `SESSION_SECRET`
  fails startup with `Invalid environment: SESSION_SECRET: ...`).
- Log in with a fresh challenge/verify flow (`POST /api/v1/auth/challenge`
  then `/api/v1/auth/verify`) and confirm the returned Bearer token is
  accepted by an authenticated endpoint.
- Confirm a session created **before** the rotation is still accepted:
  `POST /api/v1/auth/logout` (or any authenticated GET) with a
  pre-rotation token should still succeed until it naturally expires or is
  revoked — this is the expected zero-downtime behavior described above.

### Rollback

Restore the previous value and re-roll the deployment. Because rotation never
invalidated anything, rollback is symmetric and safe at any point in the
rotation.

### Emergency invalidation (compromise, not routine rotation)

If `SESSION_SECRET` itself is suspected to have leaked, that alone does not
grant an attacker any session — but treat it as a signal to audit and force
a broad session reset:

1. Rotate `SESSION_SECRET` anyway (defense in depth for any future
   dependence on it).
2. Immediately invalidate all outstanding sessions regardless of expiry:
   ```sql
   UPDATE "AuthSession" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
   ```
   `SessionService.validate()` rejects any session with `revokedAt` set, so
   this takes effect on the next request per session — no restart required.
3. Force every user to re-authenticate (SEP-53 challenge/verify) to obtain
   a new session.
4. This is intentionally non-zero-downtime for end users (they are logged
   out), but it is zero-downtime for the service itself — no deploy needed.

---

## CREDENTIAL_SIGNING_SECRET

### How it's actually used

`CredentialsService` and `ProofsService` both read
`credentialSigningSecret` via `configService.getOrThrow`. `ProofsService`
computes `hmac-sha256:<hex>` over the canonicalized credential payload when a
proof is issued (`src/proofs/proofs.service.ts`, `createHmac("sha256", this.signingSecret)`);
`CredentialsService.verifyCredential()` recomputes the same HMAC to check a
submitted credential's signature. It also seeds
`VERIFICATION_HASH_SALT_V0` as a fallback in `VerificationEventService` when
no explicit salt is configured — see [docs/data-retention.md](../data-retention.md)
and treat that fallback as a reason to configure `VERIFICATION_HASH_SALT_V0`
explicitly rather than relying on it.

Unlike `SESSION_SECRET`, this secret's *value* is load-bearing:
**changing it immediately invalidates the signature on every
previously-issued credential/proof**, because verification recomputes the
HMAC with whatever secret is currently configured.

### Zero-downtime rotation strategy: dual-key validation

Because in-flight and previously-issued credentials must keep verifying
during a rotation window, verification needs to accept **both** the old and
new secret until every outstanding credential has either been re-issued or
has expired/been revoked through normal proof lifecycle. This is not
implemented today (`CredentialsService` reads a single secret) — treat the
steps below as the required code + config change to do the rotation safely,
not as an existing toggle:

1. **Prepare:** add a second, optional env var (e.g.
   `CREDENTIAL_SIGNING_SECRET_PREVIOUS`) and change
   `CredentialsService.verifyCredential()` to attempt verification against
   the current `credentialSigningSecret` first, then — only if that fails —
   against `credentialSigningSecretPrevious` when it is configured. Keep
   **issuance** (`ProofsService`) pinned to the current secret only; only
   verification needs to accept two.
2. **Rotate:**
   - Set `CREDENTIAL_SIGNING_SECRET_PREVIOUS` to the *current* (soon to be
     old) value.
   - Set `CREDENTIAL_SIGNING_SECRET` to a newly generated value
     (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - Deploy. From this point, new proofs are signed with the new secret;
     credentials signed under the old secret still verify via the fallback.
3. **Transition window:** keep both configured for at least the maximum
   lifetime of an outstanding credential/proof that must still verify (see
   `RETENTION_FAILED_ANCHORING_DAYS` / proof-related retention windows in
   [docs/data-retention.md](../data-retention.md) for the longest-lived
   class relevant to your deployment — default guidance: **30 days**, long
   enough for any reasonably fresh proof to be re-verified or to have been
   superseded).
4. **Finalize:** once you've confirmed (via audit/verification-event logs,
   see below) that verification traffic against the old secret has dropped
   to zero, remove `CREDENTIAL_SIGNING_SECRET_PREVIOUS` entirely and
   redeploy.

**Timeline estimate:** 30–45 days end-to-end for a fully zero-downtime
rotation (dominated by the transition window, not the deploys themselves,
which are ~15 minutes each). For an environment where credential lifetime is
short-lived or the fallback isn't implemented yet, a same-day rotation is
still possible but **will invalidate outstanding unverified credentials** —
see Emergency invalidation below for that tradeoff made explicit.

### Verification

- After step 2, issue a new proof and confirm
  `POST /api/v1/proofs/:id/verify` succeeds (signed with the new secret).
- Verify a proof issued **before** the rotation still succeeds (exercises the
  `CREDENTIAL_SIGNING_SECRET_PREVIOUS` fallback path).
- Watch verification-event / audit logs for `SIGNATURE_INVALID` outcomes
  spiking after the rotation — that indicates the fallback isn't wired
  correctly or the previous secret was recorded incorrectly.

### Rollback

If verification failures spike immediately after rotating:

1. Re-set `CREDENTIAL_SIGNING_SECRET` back to the previous value (still
   available in `CREDENTIAL_SIGNING_SECRET_PREVIOUS` if you followed the
   procedure above) and redeploy.
2. Because the previous secret never stopped being accepted for
   verification during the window, this fully restores service with no
   data loss — no credential re-issuance is required.

### Emergency invalidation (compromise, non-zero-downtime path)

If the signing secret has leaked (e.g. exposed in logs, a compromised CI
runner), an attacker can forge credentials that pass verification. Do **not**
use the dual-key path — that would keep the compromised secret valid during
the transition window:

1. Rotate `CREDENTIAL_SIGNING_SECRET` to a new value immediately, with
   **no** `CREDENTIAL_SIGNING_SECRET_PREVIOUS` set.
2. This invalidates every previously-issued credential/proof signature
   immediately — verification of anything signed under the old secret will
   now fail with `SIGNATURE_INVALID`. This is intentional: it is the
   emergency's cost.
3. Notify integrators/verifiers that outstanding proofs must be re-verified
   against freshly re-issued credentials.
4. Audit `VerificationEvent` records (see
   [docs/data-retention.md](../data-retention.md)) around the suspected
   compromise window for anomalous verification patterns.

---

## PAYMENT_ENCRYPTION_KEY

### How it's actually used

`PAYMENT_ENCRYPTION_KEY` must decode (as 64-char hex or base64) to exactly 32
bytes (enforced by `encryptionKey` in `src/config/env.validation.ts`). It is
read via `configService.getOrThrow("paymentEncryptionKey")` in:

- `src/webhooks/webhooks.service.ts` and `src/webhooks/webhook-delivery.service.ts`
  — encrypting webhook secrets/payload material at rest.
- `src/proofs/proofs.service.ts` — decrypting protected payment amounts
  (`decryptProtectedAmount`) when composing proof responses.
- `src/common/crypto/protected-amount.ts` — the shared AES-256-GCM
  encrypt/decrypt helpers; `encryptProtectedAmount`/`decryptProtectedAmount`
  both take the key as an explicit argument, so both encryption and
  decryption of existing `Payment.amountEncrypted` rows depend on this exact
  key.

**This is the highest-risk secret to rotate carelessly**: unlike the signing
secret (which only affects *verification* of new vs. old signatures),
changing this key makes **every already-encrypted `amountEncrypted` column
value permanently undecryptable** unless you keep the old key available for
decryption. There is no "try both keys" fallback implemented today in
`protected-amount.ts` — it takes a single key.

### Zero-downtime rotation strategy: re-encrypt in place, dual-read during migration

1. **Prepare:** add a `PAYMENT_ENCRYPTION_KEY_PREVIOUS` env var and change
   the read path (`ProofsService`, and anywhere else that calls
   `decryptProtectedAmount`) to attempt decryption with
   `paymentEncryptionKey` first, falling back to
   `paymentEncryptionKeyPrevious` on failure — mirroring the
   `CREDENTIAL_SIGNING_SECRET` dual-key approach above. Keep **new writes**
   (`encryptProtectedAmount`, e.g. on new payment ingestion in
   `src/payments/`) pinned to the current key only.
2. **Rotate:**
   - Set `PAYMENT_ENCRYPTION_KEY_PREVIOUS` to the current value.
   - Set `PAYMENT_ENCRYPTION_KEY` to a newly generated value:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   - Deploy. New payments are encrypted under the new key; existing rows
     still decrypt via the fallback.
3. **Re-encrypt existing rows** (this is the step that actually removes the
   old key's blast radius — don't skip it): write a one-off migration script
   that reads each `Payment.amountEncrypted` (and any other encrypted
   column protected by this key), decrypts with the fallback key, and
   re-encrypts with the current key, in batches, with the app continuing to
   serve traffic (the dual-read path in step 1 makes rows correct
   regardless of which key encrypted them at any point during the
   migration).
4. **Finalize:** once 100% of rows are confirmed re-encrypted under the
   current key (verify with a query — see below), remove
   `PAYMENT_ENCRYPTION_KEY_PREVIOUS` and redeploy, and delete/retire the old
   key from the secret store.

**Timeline estimate:** depends on `Payment` table size — plan for a batch
re-encryption job that runs well under normal request load (e.g. a few
thousand rows/minute) to avoid contention with the payment-sync job in
`src/jobs/`. For a small-to-medium deployment, expect **1–3 days**
end-to-end (mostly waiting on the batch job plus a safety buffer before
retiring the old key), even though each deploy is ~15 minutes.

### Verification

- After step 2, sync a new payment and confirm its `amountEncrypted` value
  decrypts correctly when fetched through the proofs API (issue a proof or
  hit an authenticated payment-detail endpoint).
- Confirm pre-rotation rows still decrypt (dual-read fallback path) by
  fetching a payment/proof created before the rotation.
- After step 3, run a verification pass: attempt decryption of a sample of
  rows using **only** the new key (temporarily, in a script/console) to
  confirm re-encryption succeeded before you remove the previous key.
- Watch application logs for decrypt failures (`protected-amount.ts` throws
  on wrong key/tag mismatch) — any occurrence after finalization means a row
  was missed by the re-encryption batch.

### Rollback

- Before finalization (old key still configured as
  `PAYMENT_ENCRYPTION_KEY_PREVIOUS` and still present in the secret store):
  revert `PAYMENT_ENCRYPTION_KEY` to the old value and redeploy. No data is
  lost since re-encryption is idempotent and can be re-run later.
- After finalization (old key discarded): rollback is **not possible** for
  any row that was only ever re-encrypted under the new key. This is why
  step 4 must not run until re-encryption is independently verified as
  complete.

### Emergency invalidation (compromise, non-zero-downtime path)

A leaked `PAYMENT_ENCRYPTION_KEY` exposes indexed payment amounts (not
wallet identities or credentials, which are protected separately) to
decryption by whoever holds it. Because payment amounts are already
persisted ciphertext, "invalidating" the key doesn't undo past exposure —
the response here is about limiting further exposure and restoring
confidentiality going forward:

1. Rotate immediately to a new key with **no** fallback path enabled if the
   dual-key code isn't already deployed — accept that this makes existing
   `amountEncrypted` values undecryptable until you complete an emergency
   re-encryption pass using the compromised key (kept only long enough to
   run that pass, then destroyed).
2. If the dual-key mechanism from the zero-downtime path above is already in
   place, treat the compromised key as `PAYMENT_ENCRYPTION_KEY_PREVIOUS`,
   rotate `PAYMENT_ENCRYPTION_KEY` to a new value, and run the re-encryption
   batch (step 3 above) on an expedited timeline rather than the normal
   1–3 day window — prioritize throughput over avoiding load, since the old
   key needs to be retired as soon as possible.
3. Once re-encryption is complete and verified, destroy the compromised key
   everywhere it was held (secret store, any operator's local copies, CI
   history if it was ever committed or logged).
4. Treat any payment amount data that could have been decrypted with the
   compromised key as exposed for the purposes of incident reporting, even
   though the ciphertext itself was never directly served to the attacker.

---

## General notes

- **Never log secret values.** `env.validation.ts` is deliberately written
  so that validation error messages name the offending variable key but
  never echo its value — keep that property when adding any dual-key
  fallback logic above (log "verification succeeded via previous key", not
  the key itself).
- **Generate secrets with a CSPRNG**, not a password manager's "memorable"
  mode: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  for `SESSION_SECRET` / `PAYMENT_ENCRYPTION_KEY` (32 bytes required for the
  latter), or `.toString('hex')` for `CREDENTIAL_SIGNING_SECRET` (length ≥ 8
  enforced, but treat 32 bytes as the practical minimum).
- **Rotate on a schedule, not just on suspicion** — a reasonable default is
  every 90 days for `CREDENTIAL_SIGNING_SECRET` and `PAYMENT_ENCRYPTION_KEY`
  (both have real rotation cost, so track it as scheduled work), and
  opportunistically for `SESSION_SECRET` (near-zero cost, per the analysis
  above).
- See [docs/disaster-recovery.md](../disaster-recovery.md) for the adjacent
  "secrets in drill output" guidance and [docs/data-retention.md](../data-retention.md)
  for how long verification/audit records that would help you investigate a
  compromise are actually retained.
