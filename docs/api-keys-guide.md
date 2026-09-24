# API key authentication

A guide for integrators building a service that talks to the EarnProof API
without a person present.

API keys are for machine-to-machine access. If a human is at the other end of
the request, use wallet authentication instead: `POST /api/v1/auth/challenge`
followed by `POST /api/v1/auth/verify` returns a session token bound to that
person. An API key is bound to an organization, holds a fixed set of scopes, and
does not expire unless you ask it to.

The two credentials are not interchangeable. A session token cannot be used where
a key is required, and a key cannot be used to manage keys.

> **The secret is shown once.** Creation and rotation are the only responses that
> ever contain it. It is stored as a SHA-256 hash, and no code path can
> reconstruct it. If you lose it, rotate the key.

## Lifecycle at a glance

| Step | Call | Credential | Result |
|---|---|---|---|
| Create | `POST /api/v1/api-keys` | Session token, organization admin | Secret, shown once |
| Check | `GET /api/v1/integrations/auth-context` | The key | Confirms the key works and lists its scopes |
| Use | any scoped endpoint | The key | |
| List | `GET /api/v1/api-keys` | Session token, organization admin | Metadata only, never secrets |
| Rotate | `POST /api/v1/api-keys/{id}/rotate` | Session token, organization admin | New secret; old one dies immediately |
| Revoke | `DELETE /api/v1/api-keys/{id}` | Session token, organization admin | Key rejected from the next request onward |

Full request and response schemas are in the OpenAPI document the API serves at
[`/docs`](http://localhost:4000/docs) (`/docs` on any deployment). This guide
covers the parts a schema cannot state: which header goes where, what each scope
buys, and how to rotate without dropping traffic.

## Creating a key

Keys are created by a person, not by a machine. The caller must be authenticated
with a wallet session token and must be an administrator of the organization the
key will belong to — either its creator, or a user with the global `ADMIN` role.

```bash
curl -X POST https://api.example.com/api/v1/api-keys \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Reporting integration",
    "scopes": ["ORG_READ", "PROOF_VERIFY"],
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | 1–120 characters. Shown in listings; make it identify the integration, not the person. |
| `scopes` | no | Defaults to none. A key with no scopes is refused by every scope-gated endpoint, which is the safe default but rarely what you meant. |
| `expiresAt` | no | ISO 8601, must be in the future. Omit for a key that never expires. |
| `organizationId` | no | Required only when you administer more than one organization. |

```json
{
  "secret": "sK3xQ9tVb7Lm2Rf8Yz1Wq4Nh6Jc0Xd5Pg9Tv3Ub7Ae",
  "apiKey": {
    "id": "ckv8v6h2b0000qzrmn831i7rn",
    "prefix": "sK3xQ9tV",
    "name": "Reporting integration",
    "status": "ACTIVE",
    "scopes": ["ORG_READ", "PROOF_VERIFY"],
    "createdAt": "2026-08-24T12:00:00.000Z",
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

`secret` is 32 random bytes, base64url-encoded: 43 characters, and the only copy
that will ever exist. `prefix` is its first 8 characters — non-secret by
construction, and what you should log or display when you need to say *which* key
did something.

Store the secret before you do anything else with the response.

## Authenticating with a key

Two headers, both required:

```http
Authorization: Bearer sK3xQ9tVb7Lm2Rf8Yz1Wq4Nh6Jc0Xd5Pg9Tv3Ub7Ae
X-Organization-Id: ckv8v6h2b0001qzrm6ap0hf3d
```

There is **no `X-API-Key` header**. The key is presented as a bearer token, the
same way a session token is, and the API tells the two apart by which routes
accept which. `X-Organization-Id` is not optional: a key is only resolvable
inside its own organization, and a request without it is rejected as
unauthenticated rather than as malformed.

Confirm a key works before wiring it into anything:

```bash
curl https://api.example.com/api/v1/integrations/auth-context \
  -H "Authorization: Bearer $EARNPROOF_API_KEY" \
  -H "X-Organization-Id: $EARNPROOF_ORG_ID"
```

```json
{
  "keyId": "ckv8v6h2b0000qzrmn831i7rn",
  "prefix": "sK3xQ9tV",
  "organizationId": "ckv8v6h2b0001qzrm6ap0hf3d",
  "scopes": ["ORG_READ", "PROOF_VERIFY"]
}
```

That endpoint requires the `ORG_READ` scope and returns nothing secret. It is the
right thing to call from a deployment smoke test.

### Why every authentication failure looks the same

A missing key, a malformed key, a key that does not exist, a revoked key, an
expired key and a key belonging to another organization all answer `401` with the
same body. That is deliberate: a response that distinguished "no such key" from
"revoked key" would let anyone holding a list of candidate keys learn which ones
are real.

Scope failures are different. A `403` means the key is genuinely valid and simply
lacks a permission — you already proved you hold the key, so naming the missing
scope costs nothing.

## Scopes

Scopes are fail-closed. An endpoint that declares required scopes demands *all*
of them, and a key holding none is refused everywhere scopes are checked.

| Scope | Grants |
|---|---|
| `ORG_READ` | Read organization context. Required by `GET /api/v1/integrations/auth-context`. |
| `ORG_ADMIN` | Organization administration and operational visibility. Required by `GET /api/v1/health/diagnostics`. |
| `PROOF_READ` | Read proofs belonging to the organization. |
| `PROOF_VERIFY` | Verify proofs and credentials on the organization's behalf. |
| `PAYMENT_READ` | Read indexed payments. |
| `PAYMENT_WRITE` | Create or reclassify payments. |

Two of these gate endpoints today — `ORG_READ` and `ORG_ADMIN`. The rest are
modelled and assignable, and the routes that will require them are being wired up
per module; grant them now if your integration will need them, and treat an
unexpected `403` as a signal to re-read this table rather than to widen the key.

Ask for the narrowest set that works. A key scoped to `ORG_READ` that leaks is an
incident; a key scoped to everything that leaks is an outage.

Note that public endpoints — credential verification at
`POST /api/v1/credentials/verify` and proof verification at
`GET /api/v1/proofs/{id}/verify` — take no credential at all. Do not spend a key
on them, and do not conclude from a working call that your key is valid.

## Rate limiting

Every route is behind a global limiter of 1000 requests per minute, and some
routes tighten it further — credential verification allows 10 per minute per
client. Exceeding a limit returns `429` with the standard error envelope.

Rate limiting is applied per client, not per key, so rotating a key does not
reset a limit and splitting traffic across two keys from the same host does not
double it.

Handle `429` with exponential backoff and jitter. Retrying immediately, or in
lockstep across replicas, turns a throttle into an outage of your own making.
[`request-limits.md`](request-limits.md) documents the size and structural limits
that apply alongside it.

## Rotating a key

Rotation issues a new secret and invalidates the old one **immediately**. There
is no overlap window and no grace period: the request that returns the new secret
is the request that kills the old one.

```bash
curl -X POST https://api.example.com/api/v1/api-keys/$KEY_ID/rotate \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

The key's `id` is stable across rotation; only the secret and its prefix change.

For a single-process integration, rotating and restarting with the new secret is
fine. For anything running more than one replica, rotate in place and you will
drop every request made between the rotation and the last replica picking up the
new value. Do this instead:

1. Create a **second** key with the same scopes.
2. Roll it out to every replica and confirm each one authenticates
   (`GET /api/v1/integrations/auth-context`).
3. Watch `lastUsedAt` on the old key in `GET /api/v1/api-keys` until it stops
   advancing.
4. Revoke the old key.

That gives you an overlap window the rotation endpoint cannot, and a rollback
that is one deploy rather than one incident.

Rotate on a schedule — 90 days is a reasonable default — and immediately if a
secret has been in a log, a shared document, a screenshot, a CI build output, or
a laptop you no longer control.

## Revoking a key

```bash
curl -X DELETE https://api.example.com/api/v1/api-keys/$KEY_ID \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

Revocation takes effect on the next request. There is no cache window to wait
out. A revoked key can never be reactivated; issue a new one.

Keys with an `expiresAt` in the past stop authenticating on their own, with no
action required and no notification. If an integration must not fail silently,
set a reminder ahead of the expiry rather than relying on the `401`.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| `400` | The request body or query is invalid. | Fix the request. |
| `401` | Missing, malformed, unknown, revoked, expired, or wrong-organization key, or a missing `X-Organization-Id`. | Check both headers, then confirm the key with `auth-context`. Do not retry. |
| `403` | Valid key, missing scope — or a session token used where organization-admin rights are required. | Read the message: it names the missing scopes. |
| `429` | Rate limited. | Back off exponentially with jitter. |
| `5xx` | Server-side failure. | Retry idempotent reads with backoff; quote `requestId` in a report. |

Every error uses the same envelope:

```json
{
  "statusCode": 403,
  "code": "FORBIDDEN",
  "message": "Insufficient scopes. Required: ORG_READ. Missing: ORG_READ.",
  "requestId": "01hwzxyz..."
}
```

Branch on `code`, never on `message`. `code` is stable across minor versions;
`message` is not. Send `X-Request-ID` with your requests and log the one that
comes back — it is what makes a support conversation short. See
[`versioning.md`](versioning.md) for what the API guarantees across versions.

## Security practices

**Store the secret as a secret.** A secrets manager, or an environment variable
injected at deploy time. Not in source control, not in a container image, not in
a build argument, not in a frontend bundle. An API key in a browser is a public
API key.

**Never put a key in a URL.** Query strings end up in access logs, proxy logs,
browser history and referrer headers. It goes in the `Authorization` header.

**Log the prefix, never the secret.** `prefix` exists precisely so you can say
which key acted without writing down the key. If a secret does reach a log,
treat it as compromised and rotate.

**One key per integration, per environment.** Shared keys cannot be revoked
without breaking an unknown set of callers, and a shared key tells you nothing
about who did what.

**Scope narrowly, expire deliberately.** Grant the minimum, and set `expiresAt`
on anything temporary — a migration script, a contractor's tooling, a proof of
concept.

**Watch `lastUsedAt`.** A key that has not been used in months is a key nobody
will notice being stolen. Revoke it.

**Rotate on exposure, not on suspicion of exposure.** Rotation is cheap; an
investigation into whether a leak was real is not.

The server side holds up its end: secrets are stored only as SHA-256 hashes,
compared in constant time, and never logged. Creation, rotation, revocation and
each successful authentication are written to the audit log with the key's
prefix and organization but never its secret or hash — see
[`audit-events.md`](audit-events.md).

## Reference

- `/docs` — the OpenAPI document, with full request and response schemas for
  every endpoint named here
- [`architecture.md`](architecture.md) — module boundaries and enforced invariants
- [`audit-events.md`](audit-events.md) — what is recorded when a key is created,
  rotated, revoked or used
- [`request-limits.md`](request-limits.md) — request size and structural limits
- [`versioning.md`](versioning.md) — API versioning and compatibility guarantees
- [`webhooks.md`](webhooks.md) — receiving signed events, the other half of an
  integration
- [`../src/common/guards/api-key.guard.ts`](../src/common/guards/api-key.guard.ts)
  and [`../src/common/guards/scopes.guard.ts`](../src/common/guards/scopes.guard.ts)
  — the code this guide describes
