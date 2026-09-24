# Design Document — Revocable Sessions

## Overview

This design replaces EarnProof's self-contained HMAC bearer tokens with database-backed, revocable sessions. Every authenticated request is validated against a live `AuthSession` row, enabling immediate server-side revocation on logout and atomic credential rotation. The HTTP transport contract (Bearer token in `Authorization` header) is unchanged, so a future secure-cookie transport can be adopted by swapping the extraction layer without touching session logic.

---

## Architecture

```
Client
  │  Authorization: Bearer <sessionId>.<32-byte-hex>
  ▼
AuthGuard                        (src/common/guards/auth.guard.ts)
  │  extract token from header
  │  call SessionService.validate(token)
  ▼
SessionService                   (src/auth/session.service.ts)
  │  sha256(token)  →  tokenHash
  │  prisma.authSession.findUnique({ where: { tokenHash } })
  │  check revokedAt, expiresAt
  │  fire-and-forget: update lastUsedAt
  │  return { sessionId, userId }
  ▼
AuthGuard (continued)
  │  prisma.user.findUnique({ where: { id: userId } })
  │  check user.status ∉ { SUSPENDED, REVOKED, DELETED }
  │  attach AuthenticatedSession to request.user
  ▼
Route handler receives AuthenticatedSession via @CurrentUser()
```

### Key design decisions

- **Opaque token, hashed storage.** The 32-byte random secret segment provides 256 bits of entropy; the SHA-256 hash stored in the database cannot be reversed to reconstruct the token. This means a full database compromise does not expose valid session credentials.
- **`sessionId` as primary key.** The id segment of the token doubles as the database `id`, eliminating a round-trip SELECT after INSERT at session creation.
- **Fire-and-forget `lastUsedAt`.** Updating `lastUsedAt` is non-critical; swallowing the error avoids cascading failures from transient DB connectivity issues.
- **Atomic rotation via `$transaction`.** Creating the successor and revoking the predecessor happen in one transaction, preventing a window where both the old and new session are simultaneously valid.
- **Idempotent revocation.** `updateMany` with `where: { revokedAt: null }` means calling `revoke` twice produces no error and no duplicate write.

---

## Components

### SessionService (`src/auth/session.service.ts`)

Responsible for the full lifecycle of an `AuthSession` row.

| Method | Signature | Behaviour |
|---|---|---|
| `create` | `(user, ttlSeconds?) → { token, sessionId, expiresAt }` | Generates opaque token, persists hash, returns raw token once. |
| `validate` | `(token) → { sessionId, userId }` | Hash lookup, revocation/expiry checks, fire-and-forget `lastUsedAt`. |
| `revoke` | `(sessionId) → void` | Idempotent `updateMany` setting `revokedAt`. |
| `rotate` | `(sessionId, user, ttlSeconds?) → { token, sessionId, expiresAt }` | Atomic: create successor + revoke predecessor in `$transaction`. |
| `revokeAll` | `(userId) → void` | Sets `revokedAt` on all non-revoked sessions for a user. |
| `deleteExpired` | `(olderThan?: Date) → number` | Deletes rows with `expiresAt < olderThan`; defaults to `new Date()`. |

### AuthService (`src/auth/auth.service.ts`)

Orchestrates the wallet-challenge login flow and delegates session management entirely to `SessionService`.

- `createChallenge` — creates a `WalletChallenge` row with a hashed nonce.
- `verifyChallenge` — validates the Stellar signature, upserts the `User`, marks the `WalletChallenge.usedAt` **before** calling `SessionService.create`, then returns the user profile plus session metadata.
- `getSession` — returns the live user record for the authenticated session's `userId`.
- `logout` — delegates to `SessionService.revoke(sessionId)`.

### AuthGuard (`src/common/guards/auth.guard.ts`)

Intercepts every protected HTTP request:

1. Reads `Authorization` header; rejects with 401 if absent or missing `Bearer ` prefix.
2. Calls `SessionService.validate(token)`; rejects on any thrown `UnauthorizedException`.
3. Fetches the live `User` row from Prisma; rejects if missing or status is `SUSPENDED`, `REVOKED`, or `DELETED`.
4. Attaches `AuthenticatedSession` to `request.user`.

The guard never logs or propagates the raw token string.

### AuthController (`src/auth/auth.controller.ts`)

| Route | Guard | Behaviour |
|---|---|---|
| `POST /auth/challenge` | none | Delegates to `AuthService.createChallenge`. |
| `POST /auth/verify` | none | Delegates to `AuthService.verifyChallenge`; returns `{ user, session: { token, tokenType, sessionId, expiresAt } }`. |
| `GET /auth/session` | AuthGuard | Returns live user data for the authenticated session. |
| `POST /auth/logout` | AuthGuard | Extracts `sessionId` from `@CurrentUser()`, delegates to `AuthService.logout`; returns `{ status: "ok" }`. |
| `POST /auth/rotate` | AuthGuard | Extracts `sessionId` and user from `@CurrentUser()`, delegates to `SessionService.rotate`; returns `{ token, tokenType, sessionId, expiresAt }`. |

### CleanupJob (`src/auth/cleanup.job.ts`)

A NestJS injectable decorated with `@Injectable()`. Uses `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)` from `@nestjs/schedule` to call `SessionService.deleteExpired()` daily. Registered as a provider in `AuthModule`.

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SessionService } from "./session.service";

@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);

  constructor(private readonly sessionService: SessionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron() {
    const deleted = await this.sessionService.deleteExpired();
    this.logger.log(`Cleanup: removed ${deleted} expired session(s).`);
  }
}
```

### AuthTokenService (`src/auth/auth-token.service.ts`) — deprecated

The legacy HMAC-signing service is kept in the repository **only** for compilation compatibility. It is annotated `@deprecated` and is not registered in `AuthModule.providers`. No production code path calls it.

---

## Data Models

### Prisma schema (AuthSession)

```prisma
/// Persisted, revocable authentication session.
/// Only a SHA-256 hash of the opaque bearer token is stored.
model AuthSession {
  id          String       @id @default(cuid())
  tokenHash   String       @unique
  userId      String
  user        User         @relation(fields: [userId], references: [id])
  createdAt   DateTime     @default(now())
  expiresAt   DateTime
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  rotatedToId String?      @unique
  rotatedTo   AuthSession? @relation("SessionRotation", fields: [rotatedToId], references: [id])
  rotatedFrom AuthSession? @relation("SessionRotation")

  @@index([userId])
  @@index([expiresAt])
  @@index([revokedAt])
}
```

### AuthenticatedSession type

```typescript
export type AuthenticatedSession = AuthenticatedUser & {
  /** Database id of the resolved AuthSession row. */
  sessionId: string;
};
```

---

## Interfaces

### Token format

```
<sessionId>.<secret>
│            └─ 32 random bytes, hex-encoded (64 chars)
└─ 12 random bytes, base64url-encoded (16 chars)
```

- Full string is the Bearer Token returned to the client.
- `sha256(token)` is stored as `AuthSession.tokenHash`.
- The sessionId segment is also the `AuthSession.id` primary key.

### Session creation response

```typescript
interface SessionCreateResult {
  token: string;      // opaque bearer token — returned to client once
  sessionId: string;  // AuthSession.id
  expiresAt: Date;    // AuthSession.expiresAt
}
```

### Rotate endpoint response

```typescript
interface RotateResponse {
  token: string;
  tokenType: "Bearer";
  sessionId: string;
  expiresAt: Date;
}
```

---

## Error Handling

| Condition | Thrown by | HTTP status | Message |
|---|---|---|---|
| Missing / wrong `Authorization` header | AuthGuard | 401 | "Missing bearer token" |
| Token without `.` separator | SessionService.validate | 401 | "Malformed session token" |
| Token hash not found in DB | SessionService.validate | 401 | "Session not found" |
| `revokedAt` is not null | SessionService.validate | 401 | "Session has been revoked" |
| `expiresAt` ≤ now | SessionService.validate | 401 | "Session has expired" |
| User not found | AuthGuard | 401 | "User not found" |
| User status is SUSPENDED/REVOKED/DELETED | AuthGuard | 401 | "Account is not active" |
| Rotate on revoked session | SessionService.rotate | 401 | "Cannot rotate an already-revoked session" |
| Rotate on missing session | SessionService.rotate | 401 | "Session not found" |

All `UnauthorizedException` messages deliberately avoid leaking whether a session ID exists versus whether it is revoked, to limit enumeration surface.

---

## Database Migration

Migration file: `prisma/migrations/20260824000000_add_auth_sessions/migration.sql`

The migration:
- Creates the `AuthSession` table with all required columns and constraints.
- Adds a unique index on `tokenHash` for O(1) lookup.
- Adds a unique index on `rotatedToId` (one session, one successor).
- Adds performance indexes on `userId`, `expiresAt`, and `revokedAt`.
- Adds foreign key from `userId` → `User.id` and self-referential FK `rotatedToId` → `AuthSession.id`.

---

## Module Wiring

### AuthModule

```typescript
@Module({
  imports: [ScheduleModule.forFeature()],
  controllers: [AuthController],
  providers: [AuthService, SessionService, AuthGuard, CleanupJob],
  exports: [SessionService, AuthGuard],
})
export class AuthModule {}
```

### AppModule

`ScheduleModule.forRoot()` must be imported once at the application root so that `@Cron` decorators are activated.

```typescript
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ ... }),
    DatabaseModule,
    AuthModule,
    // ...
  ],
})
export class AppModule {}
```

---

## Testing Strategy

### Unit tests

- **`session.service.spec.ts`** — covers all SessionService methods using a mock PrismaService:
  - Create: return shape, raw-token non-persistence, TTL application.
  - Validate: valid token, malformed token, empty string, missing session, revoked session, expired session, `lastUsedAt` update.
  - Revoke: sets `revokedAt`, idempotency.
  - Rotate: new token is distinct, predecessor is revoked atomically, rejection of revoked/missing session.
  - RevokeAll: calls `updateMany` correctly.
  - DeleteExpired: explicit cutoff, default cutoff.
  - Concurrent revocation: two simultaneous `revoke` calls both resolve.

- **`auth.service.spec.ts`** — covers AuthService methods using mock Prisma + real SessionService:
  - Challenge creation returns id and message.
  - VerifyChallenge: tokenType is Bearer, token matches opaque format, challenge is consumed, invalid signature rejected, missing challenge rejected.
  - GetSession: valid and missing user.
  - Logout delegates to SessionService.revoke.

- **`auth.guard.spec.ts`** — covers AuthGuard using mock SessionService + mock Prisma:
  - Missing Authorization header → 401.
  - Header without `Bearer ` prefix → 401.
  - SessionService throws → 401.
  - User status SUSPENDED → 401.
  - Valid token → `request.user` populated with all AuthenticatedSession fields.

- **`auth-token.service.spec.ts`** — legacy service tests retained; includes a structural test asserting AuthTokenService is not referenced in AuthGuard or AuthService production paths.

### Integration / smoke

- `app.module.spec.ts` — compiles the full DI graph (existing test).
- Build and lint pass: `npm run lint`, `npm run test -- --runInBand`, `npm run build` all exit 0.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Opaque token format invariant

*For any* valid `AuthenticatedUser` input, calling `SessionService.create(user)` SHALL return a token that matches the regular expression `/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/`.

**Validates: Requirements 2.1, 2.2**

---

### Property 2: Raw token confidentiality on creation

*For any* valid `AuthenticatedUser` input, the raw bearer token returned by `SessionService.create(user)` SHALL NOT appear as a substring of any argument passed to `prisma.authSession.create`.

**Validates: Requirements 2.3, 6.1**

---

### Property 3: TTL is applied correctly

*For any* positive integer TTL (in seconds), calling `SessionService.create(user, ttl)` SHALL return an `expiresAt` value that is within ±500 ms of `Date.now() + ttl * 1000`.

**Validates: Requirements 2.4**

---

### Property 4: Malformed tokens (no dot separator) are always rejected

*For any* string that does not contain a `.` character, calling `SessionService.validate(token)` SHALL throw an `UnauthorizedException`.

**Validates: Requirements 3.3**

---

### Property 5: lastUsedAt is updated on every successful validation

*For any* valid session token, after `SessionService.validate(token)` succeeds, `prisma.authSession.update` SHALL be called with `data: { lastUsedAt: <Date> }` for the resolved session id.

**Validates: Requirements 3.7**

---

### Property 6: Blocked user statuses are uniformly rejected

*For any* user whose `status` is one of `SUSPENDED`, `REVOKED`, or `DELETED`, `AuthGuard.canActivate` SHALL throw an `UnauthorizedException` with message "Account is not active".

**Validates: Requirements 3.8**

---

### Property 7: AuthenticatedSession is fully populated on success

*For any* valid bearer token that resolves to an active, non-revoked, non-expired session belonging to an active user, `AuthGuard.canActivate` SHALL attach an `AuthenticatedSession` to `request.user` containing all five fields: `sessionId`, `id`, `walletAddress`, `walletHash`, and `role`.

**Validates: Requirements 3.9**

---

### Property 8: Revocation idempotency

*For any* session id, calling `SessionService.revoke(sessionId)` any number of times ≥ 1 SHALL always resolve without error and SHALL result in `AuthSession.revokedAt` being set to a non-null timestamp.

**Validates: Requirements 4.3, 4.4**

---

### Property 9: Rotation produces a distinct token

*For any* valid (non-revoked) session id and `AuthenticatedUser`, calling `SessionService.rotate(sessionId, user)` SHALL return a `token` that differs from any token previously associated with `sessionId`, and the returned token SHALL match the format `/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/`.

**Validates: Requirements 5.5, 5.6**

---

### Property 10: Rotation atomicity

*For any* valid (non-revoked) session id, after `SessionService.rotate(sessionId, user)` completes, `prisma.$transaction` SHALL have been called exactly once, containing both a `create` call for the new session and an `update` call that sets `revokedAt` on the predecessor session.

**Validates: Requirements 5.1, 5.2**

---

### Property 11: deleteExpired uses the supplied cutoff

*For any* `Date` value `cutoff`, calling `SessionService.deleteExpired(cutoff)` SHALL invoke `prisma.authSession.deleteMany` with `where: { expiresAt: { lt: cutoff } }` and SHALL return the count of deleted rows.

**Validates: Requirements 9.1**
