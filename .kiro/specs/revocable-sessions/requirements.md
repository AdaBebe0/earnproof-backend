# Requirements Document

## Introduction

This feature replaces the EarnProof backend's self-contained HMAC bearer tokens with persisted, revocable sessions stored in PostgreSQL. Authentication currently issues tokens whose validity is entirely encoded in the token body; once issued, a token cannot be invalidated server-side before its expiry. The new design introduces an `AuthSession` record that is created on login, looked up on every authenticated request, and explicitly revoked on logout or rotation. Only a SHA-256 hash of the opaque bearer token is stored; the raw token material is never written to the database or to any application log. The implementation keeps the HTTP transport interface identical so a future secure-cookie transport can be adopted without changes to session logic.

The feature is substantially implemented in the codebase. This requirements document captures the complete behavioural contract against which remaining gaps — scheduled cleanup wiring, a session-rotation controller route, deprecation enforcement of `AuthTokenService`, and verified test coverage — must be validated and closed.

---

## Glossary

- **AuthSession**: A PostgreSQL row in the `AuthSession` table representing one issued session. Contains a token hash, user reference, creation time, expiry, last-used timestamp, optional revocation time, and an optional pointer to a replacement session.
- **Bearer Token**: The opaque string returned to the client at login. Format: `<sessionId>.<32-random-bytes-hex>`. Never stored in raw form.
- **Token Hash**: The SHA-256 hex digest of the raw Bearer Token. The only session material stored in the database.
- **SessionService**: The NestJS service (`src/auth/session.service.ts`) responsible for session creation, validation, revocation, rotation, and cleanup.
- **AuthService**: The NestJS service (`src/auth/auth.service.ts`) that orchestrates challenge/verify login flow and delegates session management to SessionService.
- **AuthGuard**: The NestJS guard (`src/common/guards/auth.guard.ts`) that intercepts every protected request, validates the bearer token via SessionService, and attaches the resolved session context to the request.
- **AuthTokenService**: The legacy HMAC-token service (`src/auth/auth-token.service.ts`). Kept for compilation compatibility; marked `@deprecated` and no longer called by any production code path.
- **CleanupJob**: A scheduled NestJS task that periodically calls `SessionService.deleteExpired()` to purge expired session rows.
- **Rotation**: The act of atomically revoking a current session and issuing a replacement session with fresh token material. The old session's `rotatedToId` column links to the new session id.
- **SEP-53**: The Stellar message-signing standard used for wallet-based authentication challenges.

---

## Requirements

### Requirement 1 — Session Record Structure

**User Story:** As a security engineer, I want every session to be fully described by a database record, so that I can audit, expire, and revoke sessions independently of token contents.

#### Acceptance Criteria

1. THE AuthSession SHALL contain the following columns: `id` (primary key), `tokenHash` (unique SHA-256 hex digest), `userId` (foreign key to `User`), `createdAt` (creation timestamp), `expiresAt` (expiry timestamp), `lastUsedAt` (nullable last-access timestamp), `revokedAt` (nullable revocation timestamp), and `rotatedToId` (nullable unique foreign key to a successor AuthSession).
2. THE AuthSession `tokenHash` column SHALL be indexed with a unique constraint to allow O(1) token lookup.
3. THE AuthSession SHALL maintain database indexes on `userId`, `expiresAt`, and `revokedAt` to support efficient user-scoped queries and cleanup operations.
4. THE AuthSession `rotatedToId` column SHALL carry a unique constraint so that one session can link to at most one successor.

---

### Requirement 2 — Session Creation

**User Story:** As a user, I want to receive an opaque bearer token when I authenticate, so that I can make authenticated API calls without exposing my wallet credentials.

#### Acceptance Criteria

1. WHEN a wallet challenge is successfully verified, THE SessionService SHALL create an AuthSession row and return an opaque Bearer Token, the session id, and the expiry time to the caller.
2. THE SessionService SHALL generate the Bearer Token from a cryptographically random 24-byte id segment and a cryptographically random 32-byte secret segment, concatenated with a `.` separator.
3. THE SessionService SHALL store only the SHA-256 hex digest of the full Bearer Token in `AuthSession.tokenHash`; the raw token SHALL NOT appear in the `data` argument passed to the database.
4. THE SessionService SHALL set `AuthSession.expiresAt` to the current time plus the configured TTL (default 12 hours).
5. THE AuthService SHALL mark the corresponding `WalletChallenge` as used before creating the session, so that a crash between the two writes leaves no reusable challenge open.

---

### Requirement 3 — Session Validation

**User Story:** As an API consumer, I want the server to enforce session validity on every authenticated request, so that only holders of a live, non-expired, non-revoked token can access protected resources.

#### Acceptance Criteria

1. WHEN an authenticated request is received, THE AuthGuard SHALL extract the Bearer Token from the `Authorization: Bearer <token>` header and pass it to SessionService for validation.
2. IF the `Authorization` header is absent or does not begin with `Bearer `, THEN THE AuthGuard SHALL reject the request with HTTP 401.
3. IF the Bearer Token does not contain a `.` separator, THEN THE SessionService SHALL reject the token as malformed with HTTP 401.
4. IF no AuthSession row exists for the Token Hash, THEN THE SessionService SHALL reject the request with HTTP 401 and the message "Session not found".
5. IF `AuthSession.revokedAt` is not null, THEN THE SessionService SHALL reject the request with HTTP 401 and the message "Session has been revoked".
6. IF `AuthSession.expiresAt` is less than or equal to the current time, THEN THE SessionService SHALL reject the request with HTTP 401 and the message "Session has expired".
7. WHEN a session passes all validation checks, THE SessionService SHALL update `AuthSession.lastUsedAt` to the current time in a fire-and-forget manner that does not block the request.
8. WHEN a session passes all validation checks, THE AuthGuard SHALL look up the associated `User` row and reject the request with HTTP 401 if the user's `status` is `SUSPENDED`, `REVOKED`, or `DELETED`.
9. WHEN validation succeeds, THE AuthGuard SHALL attach an `AuthenticatedSession` object (containing `sessionId`, `id`, `walletAddress`, `walletHash`, and `role`) to `request.user`.

---

### Requirement 4 — Logout and Server-Side Revocation

**User Story:** As a user, I want logout to immediately invalidate my session on the server, so that a captured bearer token cannot be replayed after I log out.

#### Acceptance Criteria

1. WHEN `POST /auth/logout` is called with a valid bearer token, THE AuthController SHALL extract the `sessionId` from the authenticated request context and pass it to `AuthService.logout`.
2. WHEN `AuthService.logout` is called, THE AuthService SHALL delegate to `SessionService.revoke` with the supplied session id.
3. WHEN `SessionService.revoke` is called, THE SessionService SHALL set `AuthSession.revokedAt` to the current time for the matching session, provided `revokedAt` is currently null.
4. THE `SessionService.revoke` operation SHALL be idempotent: calling it on an already-revoked session SHALL complete without error.
5. WHEN `POST /auth/logout` completes successfully, THE AuthController SHALL return HTTP 200 with body `{ "status": "ok" }`.

---

### Requirement 5 — Session Rotation

**User Story:** As a security engineer, I want session rotation to atomically issue a new session and revoke the old one, so that rotated credentials cannot be replayed.

#### Acceptance Criteria

1. WHEN `SessionService.rotate` is called with a valid session id, THE SessionService SHALL atomically create a successor AuthSession and set `AuthSession.revokedAt` on the predecessor within a single database transaction.
2. WHEN `SessionService.rotate` completes, THE SessionService SHALL set `AuthSession.rotatedToId` on the predecessor to the id of the new session, making the rotation chain queryable.
3. IF `SessionService.rotate` is called on a session whose `revokedAt` is not null, THEN THE SessionService SHALL throw `UnauthorizedException` with the message "Cannot rotate an already-revoked session".
4. IF `SessionService.rotate` is called on a session id that does not exist, THEN THE SessionService SHALL throw `UnauthorizedException` with the message "Session not found".
5. WHEN rotation succeeds, THE SessionService SHALL return a new Bearer Token, the new session id, and the new expiry time.
6. THE new Bearer Token returned by rotation SHALL be distinct from the previous Bearer Token.
7. THE `POST /auth/rotate` endpoint SHALL be exposed on the AuthController, protected by AuthGuard, and SHALL delegate to `SessionService.rotate` using the `sessionId` from the authenticated request context.

---

### Requirement 6 — Raw Token Confidentiality

**User Story:** As a security engineer, I want the raw bearer token to never appear in storage or logs, so that a database or log compromise does not expose valid session credentials.

#### Acceptance Criteria

1. THE SessionService SHALL NOT include the raw Bearer Token in any argument passed to `prisma.authSession.create`, `prisma.authSession.update`, or any other persistence call.
2. THE SessionService SHALL NOT pass the raw Bearer Token to any logging call, NestJS exception message, or HTTP response body beyond the initial login response.
3. THE AuthService SHALL NOT store or log the raw Bearer Token at any point in the challenge-verify flow.
4. THE AuthGuard SHALL NOT include the raw Bearer Token in any log output or HTTP error response.

---

### Requirement 7 — AuthTokenService Deprecation

**User Story:** As a developer, I want the legacy HMAC token service to be clearly marked as deprecated and unused by production code, so that there is no ambiguity about which authentication path is active.

#### Acceptance Criteria

1. THE `AuthTokenService` class SHALL be annotated with a `@deprecated` JSDoc tag and an explanatory comment stating that `SessionService` is the replacement.
2. THE `AuthModule` SHALL NOT register `AuthTokenService` as a provider in the active module configuration.
3. THE `AuthGuard` SHALL NOT call any method on `AuthTokenService`.
4. THE `AuthService` SHALL NOT call any method on `AuthTokenService`.
5. THE `auth-token.service.spec.ts` test file SHALL include at least one test that confirms `AuthTokenService` is not imported or invoked by `AuthGuard` or `AuthService`.

---

### Requirement 8 — Database Migration

**User Story:** As a DevOps engineer, I want a versioned database migration to introduce the `AuthSession` table, so that the schema change is traceable, repeatable, and reversible.

#### Acceptance Criteria

1. THE migration file for the `AuthSession` table SHALL be a valid Prisma migration SQL file located in `prisma/migrations/`.
2. THE migration SHALL create the `AuthSession` table with all columns defined in Requirement 1.
3. THE migration SHALL create the unique index on `AuthSession.tokenHash`.
4. THE migration SHALL create the unique index on `AuthSession.rotatedToId`.
5. THE migration SHALL create performance indexes on `AuthSession.userId`, `AuthSession.expiresAt`, and `AuthSession.revokedAt`.
6. THE migration SHALL add foreign key constraints from `AuthSession.userId` to `User.id` and from `AuthSession.rotatedToId` to `AuthSession.id`.

---

### Requirement 9 — Retention and Cleanup

**User Story:** As a DevOps engineer, I want expired session rows to be periodically purged, so that the `AuthSession` table does not grow unboundedly.

#### Acceptance Criteria

1. THE SessionService SHALL expose a `deleteExpired(olderThan?: Date)` method that deletes all AuthSession rows whose `expiresAt` is less than `olderThan` and returns the count of deleted rows.
2. WHEN `deleteExpired` is called without an argument, THE SessionService SHALL default `olderThan` to the current time.
3. THE application SHALL include a CleanupJob (NestJS scheduled task) that calls `SessionService.deleteExpired()` on a configurable schedule (default: daily).
4. THE CleanupJob SHALL be registered in a NestJS module so that it runs automatically when the application starts.
5. WHERE the `@nestjs/schedule` module is available, THE CleanupJob SHALL use the `@Cron` decorator to define its schedule.

---

### Requirement 10 — Test Coverage

**User Story:** As a developer, I want comprehensive tests for all session behaviours, so that regressions in authentication logic are caught before deployment.

#### Acceptance Criteria

1. THE `session.service.spec.ts` file SHALL contain unit tests covering: session creation, raw-token non-persistence verification, TTL application, validation of a valid token, rejection of a malformed token (no dot separator), rejection of an empty token, rejection of a missing session, rejection of a revoked session, rejection of an expired session, `lastUsedAt` update on valid access, revocation idempotency, rotation success, rejection of rotation of a revoked session, rejection of rotation of a missing session, token distinctness after rotation, bulk revocation via `revokeAll`, and `deleteExpired` with both an explicit cutoff and a default cutoff.
2. THE `session.service.spec.ts` file SHALL contain a concurrent-revocation test that issues two simultaneous `revoke` calls for the same session and asserts both resolve without error.
3. THE `auth.service.spec.ts` file SHALL contain tests covering: challenge creation, successful `verifyChallenge` that asserts `tokenType` is `"Bearer"` and the returned token matches the opaque format `/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/`, rejection of an invalid SEP-53 signature, challenge consumption on successful verify, rejection when no challenge exists, valid `getSession` response, `getSession` rejection for a non-existent user, and delegation from `logout` to `SessionService.revoke`.
4. THE `auth.guard.spec.ts` (or equivalent guard test) SHALL contain tests covering: rejection when the `Authorization` header is absent, rejection when the header does not start with `Bearer `, rejection when SessionService throws for an invalid token, rejection when the resolved user's status is `SUSPENDED`, and successful attachment of `AuthenticatedSession` to the request for a valid token.
5. THE `auth-token.service.spec.ts` file SHALL contain a test that imports `AuthGuard` and `AuthService` and asserts that neither module's provider list nor implementation references `AuthTokenService` in a production code path.
6. WHEN `npm run lint`, `npm run test -- --runInBand`, and `npm run build` are executed, THE build toolchain SHALL exit with code 0 and report no errors.
