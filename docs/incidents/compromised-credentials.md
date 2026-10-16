# Incident: compromised credentials

A credential this service issues or consumes is in someone else's hands: a
session token, an API key, a webhook signing secret, the credential signing
secret, the payment encryption key, or the database URL.

## Severity

| Credential | Severity | Why |
|---|---|---|
| `CREDENTIAL_SIGNING_SECRET` | **S1** | Signs proof credentials. A holder can mint credentials that verify. |
| `PAYMENT_ENCRYPTION_KEY` | **S1** | Decrypts `Payment.amountEncrypted`, `Proof.thresholdEncrypted`, `Webhook.secretEncrypted`. A holder with a backup copy reads every protected amount. |
| `DATABASE_URL` | **S1** | Full read and write access to everything. |
| `SESSION_SECRET` | **S2** | Confidentiality comes from the token's random bytes, not from this value; rotating it invalidates sessions. See "Session tokens" below. |
| API key (one organisation) | **S2** | Scoped to one tenant and to the scopes granted. |
| Webhook signing secret (one endpoint) | **S2** | Lets someone forge events *to* a customer endpoint. |
| One user session token | **S2** | One wallet's data, until it expires. Escalates to S1 if the holder has `ADMIN`. |

Escalate to S1 the moment two or more tenants are affected, or you cannot bound
what the holder has already done.

## Detect

A compromise usually arrives as a report, not an alert. Confirm it is real
before acting, and confirm without touching the secret itself.

- **A secret in a commit, log, or ticket.** Check what the value is by its
  *name* and its *location*, never by pasting it anywhere new.
- **Unexpected authenticated activity.** For an API key, the audit trail records
  every acceptance as `api_key.authenticated` with the key prefix and
  organisation.

  ```sql
  -- Read-only. Recent API key use, by prefix, without naming the key.
  SELECT "metadata"->>'prefix' AS prefix,
         "metadata"->>'organizationId' AS organization,
         count(*) AS uses,
         min("createdAt") AS first_seen,
         max("createdAt") AS last_seen
  FROM "AuditLog"
  WHERE "action" = 'api_key.authenticated'
    AND "createdAt" > now() - interval '7 days'
  GROUP BY 1, 2
  ORDER BY uses DESC;
  ```

- **Unexpected authentication.** Authentication attempts are recorded against a
  hashed wallet, never an address:

  ```sql
  -- Read-only. Authentication outcomes over the window.
  SELECT "eventType", "success", count(*)
  FROM "AuthAuditEvent"
  WHERE "createdAt" > now() - interval '24 hours'
  GROUP BY 1, 2
  ORDER BY 3 DESC;
  ```

  Both trails are best-effort by design — the authentication path fails open on
  an audit write failure — so an absence of events is not evidence of an absence
  of attempts.

- **Privileged mutations.** `AuditLog` fails closed for these, so its record is
  authoritative: if a key was created, rotated or revoked, there is a row.

## Contain

Order matters. Stop new use of the credential first, then everything issued
under it.

### 1. Session tokens

Sessions are rows in `AuthSession`, holding only `sha256(token)`. Revoking is a
column update, effective immediately for the next request.

- **One session** — the user can do this themselves with `POST
  /api/v1/auth/logout`. A responder does it through `SessionService.revoke`.
- **Every session for one user** — `SessionService.revokeAll(userId)`.
- **Every session, everywhere** — the blunt instrument, for S1 only:

  ```sql
  -- DESTRUCTIVE: signs out every user. Two-maintainer confirmation required.
  UPDATE "AuthSession" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
  ```

  Rotating `SESSION_SECRET` does **not** invalidate sessions — token
  confidentiality comes from 32 random bytes, and the secret is only checked for
  presence at start-up. Do not reach for it expecting a mass sign-out; use the
  update above.

### 2. API keys

Revoking is immediate: `ApiKeyGuard` matches on `status = ACTIVE`.

- **One key** — `DELETE /api/v1/api-keys/:id`. Writes
  `api_key.revoked` to the audit trail.
- **Rotate instead of revoke** only when the integration must keep working and
  you accept that the old secret stops working at the same instant:
  `POST /api/v1/api-keys/:id/rotate`.
- **Every key for one organisation** — revoke each through the API rather than
  by SQL, so each revocation is audited. If the volume makes that impractical,
  the SQL below skips the audit trail and the gap must be recorded in the
  incident log:

  ```sql
  -- DESTRUCTIVE: breaks every integration for this organisation, and writes no
  -- audit row. Prefer the API. Two-maintainer confirmation required.
  UPDATE "ApiKey"
  SET "status" = 'REVOKED', "revokedAt" = now()
  WHERE "organizationId" = $1 AND "status" = 'ACTIVE';
  ```

### 3. Webhook signing secrets

A leaked signing secret lets someone forge events to the customer's endpoint. It
does not grant access to this service.

- Rotate: `POST /api/v1/webhooks/:id/rotate-secret`. The customer must be told,
  because deliveries signed with the new secret fail their verification until
  they update. See [the webhook guide](../webhooks.md).
- If the customer cannot update immediately, disable the endpoint —
  `PATCH /api/v1/webhooks/:id/disable` — rather than leaving a forged-event
  channel open. Deliveries queue rather than being lost.

### 4. `CREDENTIAL_SIGNING_SECRET`

The most damaging case, and the one with a consequence that must be understood
before rotating rather than after.

Rotation stops the attacker signing new credentials. It does **not** invalidate
credentials already signed with the old secret, and depending on the deployment
it may make previously issued credentials fail verification. Before rotating,
the incident lead decides and records:

- whether credentials signed with the old secret are to remain verifiable;
- whether affected proofs will be revoked and re-issued, and who tells their
  holders.

Then rotate in the secret manager and restart the service. Verification volume
is the signal to watch afterwards; a rotation that broke existing credentials
shows up as a shift in `verifications_total` outcomes
([runbook](../runbooks/verification-outcomes.md)).

### 5. `PAYMENT_ENCRYPTION_KEY`

Rotating this key does not re-encrypt existing rows, and a mismatched key makes
protected amounts unreadable — the same failure
[disaster recovery](../disaster-recovery.md) describes for a restore without the
right key. Treat rotation as a migration, planned outside the incident, and
contain instead by cutting access to the *backups* the key would decrypt.

### 6. `DATABASE_URL`

Rotate the database password at the database, then roll the secret and restart.
Assume everything in the database was read. Proceed as a
[data exposure](data-exposure.md) as well.

## Preserve evidence

Collect before revoking where the two do not conflict; revocation at S1 does not
wait for evidence. Full rules in
[evidence-preservation.md](evidence-preservation.md).

- Snapshot the relevant audit rows to the incident store — `AuditLog` for
  mutations, `AuthAuditEvent` for authentication — with a row count and a
  timestamp range recorded in the incident log.
- Record the credential by *identifier*, never by value: an API key by its
  8-character prefix and organisation, a session by its `id`, a secret by its
  environment variable name.
- Record where the leak was found and when, and who has seen it since.
- Note whether the audit trail has gaps in the window, since the authentication
  and verification trails are best-effort.

## Recover

1. Confirm the credential is dead: an authentication attempt with it fails, and
   no `api_key.authenticated` rows appear for the prefix after the revocation
   time.
2. Issue replacements through the normal API so that the issuance is audited.
3. Reconcile what was done with the credential while it was live. For an API key,
   compare `AuditLog` mutations by that actor against what the tenant expected.
   For a session, check the same for the user.
4. Reverse unauthorised changes deliberately, one at a time, each through the
   normal API so that the reversal is audited too.
5. Close the path the credential leaked through. A rotated secret that leaks the
   same way next week is not a recovery.

## Communicate

The communications role needs, from the incident lead:

- which tenants are affected, by organisation, and what the holder could reach
  given the credential's scopes;
- the exposure window, as timestamps;
- what the affected party must do — update a webhook secret, re-issue keys,
  re-authenticate — and by when;
- what is still unknown.

Send nothing containing the credential, a wallet address, or a proof ID.

## Exit criteria

- Every affected credential is revoked or rotated, and the revocation is
  observable in the audit trail.
- No authenticated activity under the old credential after the revocation
  timestamp.
- Unauthorised changes are reversed, or explicitly accepted and recorded.
- The leak path is closed, with a test or a control that would catch a
  recurrence.
- Affected parties are notified.
- Evidence is stored, with its retention set; the decision log is complete.
