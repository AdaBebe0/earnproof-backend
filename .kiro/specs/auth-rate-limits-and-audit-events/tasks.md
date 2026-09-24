# Implementation Plan: Auth Rate Limits, Challenge Cleanup, and Persistent Audit Events

## Overview

Implements three hardening layers on top of the existing NestJS auth stack: a Redis-backed fixed-window rate limiter exposed via a NestJS guard, a scheduled cron job that prunes stale `WalletChallenge` rows in bounded batches, and a fire-and-forget `AuditService` that writes privacy-safe `AuditLog` rows for every significant auth outcome. Requires one additive Prisma migration (adding `actorHash` to `AuditLog`).

---

## Tasks

- [ ] 1. Add new environment variables and configuration entries
  - [ ] 1.1 Extend `src/config/env.validation.ts` with the seven new variables
    - Add `AUTH_CHALLENGE_RATE_LIMIT_MAX` and `AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS` as `z.coerce.number().int().positive()` with defaults `10` / `60`
    - Add `AUTH_VERIFY_RATE_LIMIT_MAX` and `AUTH_VERIFY_RATE_LIMIT_WINDOW_SECONDS` with defaults `5` / `60`
    - Add `CHALLENGE_CLEANUP_INTERVAL_CRON` as `z.string()` with default `"0 * * * *"` — cron expression validity is not checked by Zod; it is deferred to service initialization, where the `CronJob` constructor from the `cron` package will throw on an invalid expression (Requirement 4.4 requires the variable to be present and non-empty; format errors surface at startup when `ChallengeCleanupService.onModuleInit()` runs), `CHALLENGE_CLEANUP_BATCH_SIZE` as positive integer default `500`, and `CHALLENGE_USED_RETENTION_SECONDS` as positive integer default `86400`
    - Non-positive values for any numeric variable must cause a startup validation error
    - _Requirements: 3.1, 3.2, 3.3, 4.4_

  - [ ] 1.2 Extend `src/config/configuration.ts` with an `auth` section
    - Add `auth.challenge.rateLimitMax`, `auth.challenge.rateLimitWindowSeconds`, `auth.verify.rateLimitMax`, `auth.verify.rateLimitWindowSeconds` reading from `process.env` with inline `??` fallbacks wrapped in `Number()` (e.g. `rateLimitMax: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 10)`), consistent with the existing pattern in the file — the Zod schema in `env.validation.ts` ensures values are valid at startup, but `configuration.ts` still uses `process.env` directly with fallbacks
    - Add `auth.cleanup.intervalCron`, `auth.cleanup.batchSize`, `auth.cleanup.usedRetentionSeconds` using the same pattern — numeric fields wrapped in `Number()`, string field left unwrapped
    - _Requirements: 3.1, 3.2, 4.4_

  - [ ]* 1.3 Write unit tests for env validation changes
    - Test that each non-positive value for the four rate-limit integers triggers a Zod validation error
    - Test that absent variables resolve to their documented defaults
    - _Requirements: 3.2, 3.3_

- [ ] 1.4 Add `actorHash` column to `AuditLog` via Prisma migration
  - Add `actorHash String?` field to the `AuditLog` model in `prisma/schema.prisma` (no `@relation`; plain nullable string column for storing hashed wallet addresses)
  - Add `@@index([actorType, actorHash])` to the model
  - Run `prisma migrate dev --name add_audit_log_actor_hash` to generate and apply the migration, then regenerate the Prisma client so that `actorHash` is available at compile time before AuditService is implemented
  - _Requirements: 5.7_

- [ ] 2. Create the global RedisModule
  - [ ] 2.1 Create `src/common/redis/redis.provider.ts`
    - Export `REDIS_CLIENT` token constant
    - Implement `redisProvider` factory that creates an `ioredis` `Redis` instance from `configService.getOrThrow('redisUrl')` with `lazyConnect: true` and `enableOfflineQueue: false`
    - _Requirements: 1.6, 2.4_

  - [ ] 2.2 Create `src/common/redis/redis.module.ts`
    - Declare as `@Global()` NestJS module using `redisProvider`
    - Implement `OnModuleDestroy` to call `client.quit()` on teardown
    - Export `REDIS_CLIENT`
    - _Requirements: 1.6, 2.4_

- [ ] 3. Implement RateLimitService and RateLimitGuard
  - [ ] 3.1 Create `src/auth/rate-limit/rate-limit.constants.ts`
    - Export `RATE_LIMIT_NAMESPACE` metadata key string constant
    - _Requirements: 1.4_

  - [ ] 3.2 Create `src/auth/rate-limit/rate-limit.service.ts`
    - Inject `REDIS_CLIENT` (ioredis) and `Logger`
    - Implement `check(options: RateLimitOptions): Promise<RateLimitResult>` using a fixed-window INCR + EXPIRE counter: key = `rl:{namespace}:{sha256(walletAddress)}`
    - On first request in window (`count === 1`), set TTL via `expire`
    - Return `{ allowed: false, retryAfter: ttl }` when count exceeds limit
    - Wrap all Redis calls in try/catch; on error return `{ allowed: true, retryAfter: 0 }` and emit a `warn`-level log
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.1, 2.2, 2.4_

  - [ ]* 3.3 Write property tests for RateLimitService
    - **Property 1: Rate-limit key never exposes raw wallet address** — for any valid Stellar public key, the Redis key must equal `"rl:{namespace}:" + sha256(walletAddress)` and must not contain the raw address
    - **Validates: Requirements 1.1, 2.1**
    - **Property 2: Enforcement threshold** — for limit N, first N requests are allowed; (N+1)th is rejected with non-negative `retryAfter`
    - **Validates: Requirements 1.2, 1.3, 2.2, 2.5**
    - **Property 3: Namespace isolation** — `challenge` and `verify` keys differ for the same wallet; both begin with `rl:` prefix
    - **Validates: Requirements 1.4**
    - **Property 5: Redis failure allows request through** — if Redis throws, returns `{ allowed: true }` and logs at `warn` level
    - **Validates: Requirements 1.6, 2.4**

  - [ ] 3.4 Create `src/auth/rate-limit/rate-limit.guard.ts`
    - Inject `RateLimitService`, `AuditService`, `ConfigService`, and `Reflector`
    - Read `RATE_LIMIT_NAMESPACE` from handler metadata via `Reflector`
    - Extract `walletAddress` from `request.body`
    - Read limit and window from config (`auth.challenge.*` or `auth.verify.*`) based on namespace
    - Call `RateLimitService.check()`; if not allowed, call `auditService.logLoginFailed({ reason: 'rate_limited', walletAddress })` (no `resourceId` — no challenge has been fetched at the point of rate-limit rejection), then throw `HttpException({ statusCode: 429, message: 'Too many requests. Please try again later.', retryAfter }, 429)`
    - _Requirements: 1.2, 1.3, 2.2, 2.5, 5.5_

  - [ ]* 3.5 Write unit tests for RateLimitGuard
    - Mock `RateLimitService` to return `{ allowed: false, retryAfter: 30 }` and verify 429 is thrown with correct shape
    - Verify guard short-circuits before `AuthService` is called
    - Verify `AuditService.logLoginFailed` is called with `reason: 'rate_limited'`
    - _Requirements: 1.2, 1.3, 5.5_

- [ ] 4. Checkpoint — core rate-limit layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement AuditService
  - [ ] 5.1 Create `src/auth/audit/audit.service.ts`
    - Inject `PrismaService` and `Logger`
    - Implement `logChallengeCreated(challengeId: string, walletAddress: string): void` — writes `action: 'auth.challenge.created'`, `actorType: 'wallet'`, `actorHash: sha256(walletAddress)`, `actorId: undefined`, `resourceType: 'WalletChallenge'`, `resourceId: challengeId`
    - Implement `logLoginSuccess(userId: string, walletAddress: string): void` — writes `action: 'auth.login.success'`, `actorType: 'wallet'`, `actorHash: sha256(walletAddress)`, `actorId: userId` (FK to User), `resourceType: 'User'`, `resourceId: userId`
    - Implement `logLoginFailed(options: { walletAddress: string; reason: 'invalid_signature' | 'challenge_unavailable' | 'rate_limited'; resourceId?: string }): void` — writes `action: 'auth.login.failed'`, `actorType: 'wallet'`, `actorHash: sha256(walletAddress)`, `actorId: undefined`, `resourceType: 'WalletChallenge'`, `resourceId: options.resourceId` (null for `rate_limited`), `metadata: { reason: options.reason }`
    - All three methods delegate to a private `write()` that calls `prisma.auditLog.create().catch(err => logger.error(...))`; errors are never rethrown
    - `actorHash` MUST always be `sha256(walletAddress)` — raw addresses are never stored; `actorId` is only set to a real User FK value, never set to a hashed wallet address
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ]* 5.2 Write property tests for AuditService
    - **Property 8: actorHash is always hashed** — for any wallet address W, `actorHash` in the written row equals `sha256(W)` and does not equal W; `actorId` is null except for `auth.login.success` events where it equals the userId
    - **Validates: Requirements 5.6, 5.7**
    - **Property 9: Audit fields are correct for all auth outcomes** — for each of the three event types, verify `action`, `actorType`, `actorHash`, `resourceType`, `resourceId`, and `metadata` match the prescribed values; in particular `resourceId` is null for the `rate_limited` reason
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
    - **Property 10: Audit failure does not propagate** — if `prisma.auditLog.create` rejects, the service method must return without throwing
    - **Validates: Requirements 5.8, 6.1_

- [ ] 6. Implement ChallengeCleanupService
  - [ ] 6.1 Create `src/auth/cleanup/challenge-cleanup.service.ts`
    - Inject `PrismaService`, `ConfigService`, `SchedulerRegistry`, and `Logger`
    - Read `auth.cleanup.intervalCron`, `auth.cleanup.batchSize`, and `auth.cleanup.usedRetentionSeconds` from config in the constructor
    - Implement `onModuleInit()`: create a `CronJob` (imported directly: `import { CronJob } from 'cron'`) with the configured expression and register it via `this.schedulerRegistry.addCronJob('challenge-cleanup', job); job.start()` — do NOT use `@Cron(this.cronExpression)` as a decorator; NestJS decorators resolve at class-definition time before the constructor runs, so `this.cronExpression` would be undefined
    - Implement `async runCleanup(): Promise<void>` with bounded delete: first `findMany` (with `take: batchSize`, `orderBy: createdAt asc`) of rows where `expiresAt < now` OR (`usedAt != null` AND `usedAt < now - usedRetentionSeconds`), selecting only `id`
    - If `ids.length === 0`, return without any DB write
    - Call `deleteMany({ where: { id: { in: ids } } })`
    - Log `"Challenge cleanup: deleted ${count} stale rows"` only when count > 0
    - Wrap entire method body in try/catch; on error log and return without rethrowing
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 6.2 Write property tests for ChallengeCleanupService
    - **Property 6: Batch size always respected** — for any positive batch size N and any table size > N, a single `runCleanup()` call deletes at most N rows
    - **Validates: Requirements 4.3**
    - **Property 7: Log message reflects actual deletion count** — for count C > 0, exactly one log message includes C; for C = 0, no such log is emitted
    - **Validates: Requirements 4.7, 4.5**

- [ ] 7. Checkpoint — all new services complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Integrate AuditService into AuthService
  - [ ] 8.1 Update `src/auth/auth.service.ts` to inject and call `AuditService`
    - Add `AuditService` to constructor
    - In `createChallenge`: after the `prisma.walletChallenge.create` call succeeds, call `this.auditService.logChallengeCreated(challenge.id, walletAddress)`
    - In `verifyChallenge`: after the challenge-not-found path, call `this.auditService.logLoginFailed({ walletAddress, reason: 'challenge_unavailable' })` before throwing
    - In `verifyChallenge`: after the invalid-signature path, call `this.auditService.logLoginFailed({ walletAddress, reason: 'invalid_signature', resourceId: challenge.id })` before throwing
    - In `verifyChallenge`: after the token is generated, call `this.auditService.logLoginSuccess(user.id, input.walletAddress)`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.3_

  - [ ]* 8.2 Write unit tests for updated AuthService
    - Verify `logChallengeCreated` is called with correct challenge id and wallet address on success
    - Verify `logLoginFailed` is called with `reason: 'challenge_unavailable'` when challenge not found
    - Verify `logLoginFailed` is called with `reason: 'invalid_signature'` on bad signature
    - Verify `logLoginSuccess` is called with correct user id on successful verification
    - Verify AuthService still returns session token when `AuditService` throws synchronously — mock `logLoginSuccess` with `mockImplementation(() => { throw new Error('audit failure') })` to ensure the fire-and-forget isolation holds even for sync throws
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.3_

- [ ] 9. Wire RateLimitGuard onto AuthController
  - [ ] 9.1 Update `src/auth/auth.controller.ts` to attach `RateLimitGuard`
    - Add `@SetMetadata(RATE_LIMIT_NAMESPACE, 'challenge')` and `@UseGuards(RateLimitGuard)` decorators to `createChallenge`
    - Add `@SetMetadata(RATE_LIMIT_NAMESPACE, 'verify')` and `@UseGuards(RateLimitGuard)` decorators to `verifyChallenge`
    - _Requirements: 1.2, 2.2_

  - [ ]* 9.2 Write unit tests for AuthController with RateLimitGuard
    - Use NestJS testing module with a mock `RateLimitService` returning `{ allowed: false, retryAfter: 30 }`
    - Verify POST `/challenge` returns 429 with `retryAfter` in body when rate-limited
    - Verify POST `/verify` returns 429 with `retryAfter` in body when rate-limited
    - _Requirements: 1.3, 2.5_

- [ ] 10. Update AuthModule and AppModule
  - [ ] 10.1 Update `src/auth/auth.module.ts` to register all new providers
    - Import `ScheduleModule.forRoot()` if not already imported at AppModule level (else confirm it is in AppModule)
    - Add `RateLimitService`, `RateLimitGuard`, `AuditService`, and `ChallengeCleanupService` to `providers`
    - Ensure `RedisModule` is available (global, so no import needed in AuthModule)
    - _Requirements: 1.1, 4.1, 5.1_

  - [ ] 10.2 Update `src/app.module.ts` to import `RedisModule` and `ScheduleModule.forRoot()`
    - Import `RedisModule` (from `src/common/redis/redis.module.ts`)
    - Import `ScheduleModule.forRoot()` from `@nestjs/schedule`
    - _Requirements: 1.6, 4.1_

- [ ] 11. Final checkpoint — end-to-end wiring verified
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- The `AuditLog` Prisma model requires one additive change: add `actorHash String?` (task 1.4). All other fields are already present — no other schema migration is needed
- Add `ioredis` as a pinned direct dependency: `npm install ioredis@5.6.1` before task 2 (goes in `dependencies`, not `devDependencies`)
- Add `@nestjs/schedule` as a pinned dependency: `npm install @nestjs/schedule@5.0.1` before task 6 (goes in `dependencies`; v5.x is required for NestJS 11 compatibility — v4.x is incompatible); also add `npm install cron@3.2.1` (goes in `dependencies` — `cron` is a peer dependency of `@nestjs/schedule` and must be installed explicitly)
- Property tests (tasks 3.3, 5.2, 6.2, 8.2) use Jest with `fast-check` or equivalent property-based library
- The `sha256` utility at `src/common/crypto/hash.ts` is already available and must be reused — do not reimplement

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.4", "3.1"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["3.2", "5.1", "6.1"] },
    { "id": 4, "tasks": ["3.3", "3.4", "5.2", "6.2"] },
    { "id": 5, "tasks": ["3.5", "8.1"] },
    { "id": 6, "tasks": ["8.2", "9.1", "10.1", "10.2"] },
    { "id": 7, "tasks": ["9.2"] }
  ]
}
```
