# Requirements Document

## Introduction

This feature adds three layers of authentication hardening to the EarnProof backend API:

1. **Rate limiting** — configurable per-endpoint request throttles on challenge creation and challenge verification, keyed by hashed wallet address and hashed client metadata so no raw IP addresses are ever stored.
2. **Challenge cleanup** — a bounded background cron job that removes expired and sufficiently old used `WalletChallenge` rows from PostgreSQL to prevent unbounded table growth.
3. **Persistent audit events** — privacy-safe records written to the existing `AuditLog` table covering every significant authentication outcome (challenge created, login success, login failure sub-types) without storing raw signatures or challenge message text.

Existing auth behaviour (challenge expiry, one-time use enforcement, Stellar key validation, SEP-53 signature verification, safe response shapes) is preserved unchanged.

---

## Glossary

- **AuthService**: The NestJS service in `src/auth/auth.service.ts` that handles challenge creation and challenge verification.
- **RateLimitService**: A new injectable NestJS service that manages fixed-window counters backed by Redis.
- **ChallengeCleanupService**: A new NestJS service annotated with `@nestjs/schedule` that periodically deletes stale `WalletChallenge` rows.
- **AuditLog**: The existing Prisma model with fields `actorType`, `actorId` (FK to `User.id`), `actorHash` (new plain string column for hashed wallet addresses), `action`, `resourceType`, `resourceId`, and `metadata`.
- **AuditService**: A new injectable NestJS service that writes rows to the `AuditLog` table.
- **WalletChallenge**: The existing Prisma model representing a one-time auth challenge tied to a Stellar wallet address.
- **HashedWalletKey**: A rate-limit bucket key derived by passing the wallet address through the existing `sha256()` utility from `src/common/crypto/hash.ts`.
- **Redis**: The Redis instance already present in the stack and reachable via the `REDIS_URL` environment variable.
- **Throttle limit**: The maximum number of requests allowed per wallet per time window for a given endpoint.
- **Window duration**: The rolling or fixed time interval (in seconds) over which the Throttle limit applies.
- **Cleanup batch size**: The maximum number of `WalletChallenge` rows deleted in a single cleanup job execution.
- **Cleanup interval**: The cron schedule expression that controls how frequently the ChallengeCleanupService runs.
- **Stale challenge**: A `WalletChallenge` row whose `expiresAt` is in the past, or whose `usedAt` is set and is older than a configured retention period.
- **429 response**: An HTTP 429 Too Many Requests response containing a `retryAfter` value in seconds and a human-readable message.
- **Audit event action**: A dot-separated string identifying the event type; one of `auth.challenge.created`, `auth.login.success`, `auth.login.failed`.

---

## Requirements

### Requirement 1 — Challenge-creation rate limiting

**User Story:** As a platform operator, I want to limit how many authentication challenges a wallet can request in a given window, so that I can prevent denial-of-service abuse against challenge creation without storing raw client IP addresses.

#### Acceptance Criteria

1. WHEN a challenge creation request is received, THE RateLimitService SHALL derive a rate-limit key by hashing the wallet address with `sha256()`, producing a HashedWalletKey that contains no raw wallet address.
2. WHEN the per-wallet challenge creation count within the configured Window duration reaches the configured Throttle limit, THE AuthService SHALL reject the request with an HTTP 429 response before creating a WalletChallenge record.
3. THE 429 response body SHALL include a `retryAfter` field containing the number of seconds until the oldest counter entry expires.
4. THE RateLimitService SHALL persist rate-limit counters in Redis using a key namespace that prevents collision with other application keys.
5. THE Throttle limit and Window duration for challenge creation SHALL be independently configurable via environment variables without requiring a code change.
6. IF the Redis connection is unavailable when a rate-limit check is performed, THEN THE RateLimitService SHALL allow the request to proceed and SHALL log a warning, ensuring the unavailability of Redis does not block authentication.

### Requirement 2 — Challenge-verification rate limiting

**User Story:** As a platform operator, I want to limit how many verification attempts a wallet can make in a given window, so that I can prevent brute-force attacks on challenge verification.

#### Acceptance Criteria

1. WHEN a challenge verification request is received, THE RateLimitService SHALL derive a rate-limit key using the HashedWalletKey from the `walletAddress` field in the request body.
2. WHEN the per-wallet verification count within the configured Window duration reaches the configured Throttle limit, THE AuthService SHALL reject the request with an HTTP 429 response before performing signature validation.
3. THE Throttle limit and Window duration for challenge verification SHALL be independently configurable from the challenge creation limits via separate environment variables.
4. IF the Redis connection is unavailable during a verification rate-limit check, THEN THE RateLimitService SHALL allow the request to proceed and SHALL log a warning so that authentication is not disrupted.
5. THE 429 response body for verification SHALL include a `retryAfter` field containing the number of seconds until the rate-limit window resets.

### Requirement 3 — Configurable rate-limit environment variables

**User Story:** As a platform operator, I want all rate-limit thresholds declared as validated environment variables, so that I can tune limits per environment without touching source code.

#### Acceptance Criteria

1. THE system SHALL recognise the following environment variables: `AUTH_CHALLENGE_RATE_LIMIT_MAX`, `AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS`, `AUTH_VERIFY_RATE_LIMIT_MAX`, `AUTH_VERIFY_RATE_LIMIT_WINDOW_SECONDS`.
2. WHEN any of the four rate-limit environment variables is absent, THE system SHALL apply a documented default value and start without error.
3. WHEN any of the four rate-limit environment variables contains a non-positive integer, THE system SHALL throw a validation error at startup before accepting any requests.

### Requirement 4 — Expired and used challenge cleanup

**User Story:** As a platform operator, I want expired and sufficiently old used challenge rows removed automatically, so that the `WalletChallenge` table does not grow without bound.

#### Acceptance Criteria

1. THE ChallengeCleanupService SHALL delete WalletChallenge rows whose `expiresAt` is earlier than the current time.
2. THE ChallengeCleanupService SHALL delete WalletChallenge rows whose `usedAt` is set and is older than a configurable retention period.
3. WHEN the ChallengeCleanupService runs, THE ChallengeCleanupService SHALL delete at most the configured Cleanup batch size rows per execution to prevent long-running database transactions.
4. THE Cleanup interval and Cleanup batch size SHALL each be configurable via environment variables without requiring a code change.
5. WHEN no stale challenges exist, THE ChallengeCleanupService SHALL complete without error and without performing any database write.
6. IF a database error occurs during cleanup, THEN THE ChallengeCleanupService SHALL log the error and exit the current execution without rethrowing, so that the cron schedule continues for subsequent runs.
7. THE ChallengeCleanupService SHALL log the count of rows deleted at the end of each execution that deletes at least one row.

### Requirement 5 — Persistent authentication audit events

**User Story:** As a security auditor, I want every significant authentication outcome recorded in the AuditLog table without raw sensitive data, so that I can reconstruct authentication activity without exposing user credentials.

#### Acceptance Criteria

1. WHEN a WalletChallenge is successfully created, THE AuditService SHALL write an AuditLog row with `action` = `auth.challenge.created`, `resourceType` = `WalletChallenge`, `resourceId` set to the challenge id, and `actorType` = `wallet`.
2. WHEN challenge verification succeeds and a session token is issued, THE AuditService SHALL write an AuditLog row with `action` = `auth.login.success`, `resourceType` = `User`, `resourceId` set to the user id, and `actorType` = `wallet`.
3. WHEN challenge verification fails due to an invalid signature, THE AuditService SHALL write an AuditLog row with `action` = `auth.login.failed`, `metadata` containing `{ "reason": "invalid_signature" }`, `resourceType` = `WalletChallenge`, and `resourceId` set to the challenge id.
4. WHEN challenge verification fails because the challenge is expired or not found, THE AuditService SHALL write an AuditLog row with `action` = `auth.login.failed`, `metadata` containing `{ "reason": "challenge_unavailable" }`, and `resourceType` = `WalletChallenge`.
5. WHEN a request is rejected by the RateLimitService with a 429 response, THE AuditService SHALL write an AuditLog row with `action` = `auth.login.failed`, `metadata` containing `{ "reason": "rate_limited" }`, `resourceType` = `WalletChallenge`, and `resourceId` omitted (null) because no challenge has been fetched at the point of rate-limit rejection. Note: setting `resourceType` to `WalletChallenge` when no challenge record exists is a deliberate tradeoff for consistency with other `auth.login.failed` events; the null `resourceId` is the distinguishing signal that identifies this as a rate-limit event rather than a challenge-specific failure.
6. THE AuditService SHALL never store raw signature values, raw challenge message text, or raw wallet addresses in any AuditLog field.
7. THE AuditService SHALL store the HashedWalletKey in the `actorHash` field of AuditLog rows so that events are linkable across a session without revealing the raw wallet address. The `actorId` field (a foreign key to `User.id`) SHALL be populated only when the actor is a known User, and SHALL be left null for pre-authentication events.
8. IF the AuditLog database write fails, THEN THE AuditService SHALL log the error and return without rethrowing, so that an audit failure does not block or fail the primary authentication response.

### Requirement 6 — Audit and rate-limit failure isolation

**User Story:** As a platform operator, I want failures in the audit and rate-limit subsystems to be non-fatal, so that infrastructure degradation does not cause unintended authentication outcomes.

#### Acceptance Criteria

1. IF the AuditService write fails for a successful login, THEN THE AuthService SHALL still return the session token to the caller.
2. IF the RateLimitService throws an unhandled exception during a limit check, THEN THE AuthService SHALL treat the result as "not rate-limited" and proceed with the normal authentication flow.
3. THE AuthService SHALL never catch a rate-limit or audit error and convert it into a successful authentication response for an otherwise invalid request.
