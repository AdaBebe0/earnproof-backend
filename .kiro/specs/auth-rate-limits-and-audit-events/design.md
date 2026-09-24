# Design Document

## Feature: Auth Rate Limits, Challenge Cleanup, and Persistent Audit Events

---

## Overview

This feature adds three hardening layers to the EarnProof authentication API without altering existing auth semantics:

1. **RateLimitService** — fixed-window per-wallet counters backed by Redis (ioredis), enforced via NestJS Guards on the challenge-creation and challenge-verification endpoints.
2. **ChallengeCleanupService** — a `@nestjs/schedule` cron job that removes stale `WalletChallenge` rows in bounded batches.
3. **AuditService** — a fire-and-forget service that writes privacy-safe `AuditLog` rows for every significant auth outcome, storing the hashed wallet key rather than raw addresses.

All three services are designed to fail in a non-fatal manner: Redis outages and audit write failures degrade gracefully without blocking auth.

---

## Architecture

### Module Structure

```
src/auth/
  auth.module.ts          ← extended: imports ScheduleModule, RedisModule; provides new services + guards
  auth.service.ts         ← extended: calls AuditService and RateLimitService
  auth.controller.ts      ← extended: attaches RateLimitGuard to POST /challenge and POST /verify
  rate-limit/
    rate-limit.service.ts
    rate-limit.guard.ts
    rate-limit.constants.ts
    rate-limit.service.spec.ts
  audit/
    audit.service.ts
    audit.service.spec.ts
  cleanup/
    challenge-cleanup.service.ts
    challenge-cleanup.service.spec.ts

src/common/redis/
  redis.module.ts         ← Global module exposing ioredis instance under REDIS_CLIENT token
  redis.provider.ts
```

### Dependency Graph

```
AppModule
  └─ ScheduleModule.forRoot()
  └─ RedisModule (global)
      └─ REDIS_CLIENT (ioredis.Redis)
  └─ AuthModule
      ├─ RateLimitService      ← injects REDIS_CLIENT, ConfigService
      ├─ RateLimitGuard        ← injects RateLimitService, Reflector
      ├─ AuditService          ← injects PrismaService (global), Logger
      ├─ ChallengeCleanupService ← injects PrismaService, ConfigService, SchedulerRegistry, Logger
      ├─ AuthService           ← extended: injects AuditService, RateLimitService
      └─ AuthTokenService
```

---

## Components

### 1. RedisModule (Global)

A `@Global()` NestJS module that creates a single `ioredis.Redis` instance from `REDIS_URL` and exposes it via the `REDIS_CLIENT` injection token. The module implements `OnModuleDestroy` to close the connection cleanly.

```typescript
// src/common/redis/redis.provider.ts
import Redis from "ioredis";

export const REDIS_CLIENT = "REDIS_CLIENT";

export const redisProvider = {
  provide: REDIS_CLIENT,
  useFactory: (configService: ConfigService): Redis => {
    const url = configService.getOrThrow<string>("redisUrl");
    const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false });
    return client;
  },
  inject: [ConfigService],
};
```

Setting `enableOfflineQueue: false` means commands fail immediately rather than queuing when Redis is down — this is what enables the graceful-degradation path in RateLimitService.

---

### 2. RateLimitService

Uses a Redis fixed-window counter with INCR + EXPIRE. The key structure is:

```
rl:{namespace}:{hashedWalletKey}
```

Where `namespace` is either `challenge` or `verify`.

#### Interface

```typescript
export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number; // seconds until window resets; 0 when allowed
}

export interface RateLimitOptions {
  namespace: "challenge" | "verify";
  walletAddress: string;
  limit: number;
  windowSeconds: number;
}
```

#### Algorithm

**Algorithm**: Fixed-window counter. Each wallet gets one Redis key per namespace; the counter increments on every request and the key expires after `windowSeconds`. This is simpler than a true sliding window but allows a burst of up to 2× the limit across a window boundary (e.g., limit reached near end of one window and limit again at the start of the next).

**Known behavior — concurrent first request**: Two simultaneous requests on an empty key will both INCR to `count === 1` and both attempt `EXPIRE`. The second `EXPIRE` call is harmless (it resets the TTL to the same value). For a limit of 1, both requests may be served before the counter reaches 2 on a third request. Operators should set limits with this ±1 tolerance in mind.

```typescript
async check(options: RateLimitOptions): Promise<RateLimitResult> {
  const key = `rl:${options.namespace}:${sha256(options.walletAddress)}`;
  try {
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First request in window — set TTL
      await this.redis.expire(key, options.windowSeconds);
    }
    if (count > options.limit) {
      const ttl = await this.redis.ttl(key);
      return { allowed: false, retryAfter: Math.max(ttl, 0) };
    }
    return { allowed: true, retryAfter: 0 };
  } catch (err) {
    this.logger.warn("Redis unavailable during rate-limit check; allowing request", { error: err });
    return { allowed: true, retryAfter: 0 };
  }
}
```

The `try/catch` around all Redis operations satisfies Requirements 1.6 and 2.4 — a Redis outage never blocks auth.

---

### 3. RateLimitGuard

A NestJS `CanActivate` guard that reads the endpoint-specific limit and window from config, calls `RateLimitService.check()`, and throws `HttpException(429)` with a `retryAfter` body if the limit is exceeded. The guard also calls `AuditService.logLoginFailed({ reason: 'rate_limited', walletAddress })` before throwing — no `resourceId` is passed because no challenge has been fetched at this point, so `resourceId` will be null in the resulting AuditLog row.

The guard is applied at the controller level using a metadata key to distinguish the two endpoints:

```typescript
// rate-limit.constants.ts
export const RATE_LIMIT_NAMESPACE = "RATE_LIMIT_NAMESPACE";

// Usage in controller:
@SetMetadata(RATE_LIMIT_NAMESPACE, "challenge")
@Post("challenge")
createChallenge(...) {}

@SetMetadata(RATE_LIMIT_NAMESPACE, "verify")
@Post("verify")
verifyChallenge(...) {}
```

The guard extracts `walletAddress` from the request body (available for both endpoints) and the namespace from request metadata.

#### 429 Response Shape

```json
{
  "statusCode": 429,
  "message": "Too many requests. Please try again later.",
  "retryAfter": 42
}
```

---

### 4. AuditService

A thin service that wraps `prisma.auditLog.create()` calls. All methods are `async` but failures are caught internally — callers never need to await or catch.

#### Interface

```typescript
export interface AuditEventPayload {
  action: "auth.challenge.created" | "auth.login.success" | "auth.login.failed";
  actorType: "wallet";
  actorHash: string;        // sha256(walletAddress) — never raw address
  actorId?: string;         // FK to User.id — only populated when actor is a known User
  resourceType: "WalletChallenge" | "User";
  resourceId?: string;
  metadata?: Record<string, unknown>;
}
```

#### Methods

```typescript
logChallengeCreated(challengeId: string, walletAddress: string): void
logLoginSuccess(userId: string, walletAddress: string): void
logLoginFailed(options: { walletAddress: string; reason: "invalid_signature" | "challenge_unavailable" | "rate_limited"; resourceId?: string; }): void
```

Each method constructs the `AuditEventPayload` and calls a private `write()` helper:

```typescript
private write(payload: AuditEventPayload): void {
  this.prisma.auditLog
    .create({ data: { ...payload } })
    .catch((err) => this.logger.error("AuditLog write failed", { error: err }));
}
```

Notably, `write()` is fire-and-forget: it calls `.catch()` to swallow errors and logs them without rethrowing. This satisfies Requirement 5.8.

The `actorHash` field always receives `sha256(walletAddress)`. The `actorId` field (FK to `User.id`) is populated only for `auth.login.success` events where a `userId` is known; it is left `undefined` (null) for all other events. Raw addresses, signatures, and message text are never passed in and never stored (Requirement 5.6, 5.7).

---

### 5. ChallengeCleanupService

Annotated with `@Injectable()` and implements `OnModuleInit`. The cron expression and batch size are read from config at construction time. Because NestJS decorators resolve at class-definition time (before the constructor runs), `@Cron(this.cronExpression)` cannot be used — `this.cronExpression` is `undefined` when the decorator evaluates. Instead, the job is registered programmatically via `SchedulerRegistry` in `onModuleInit()`:

```typescript
// CronJob is imported directly from the `cron` package: `import { CronJob } from 'cron'`
async onModuleInit(): Promise<void> {
  const job = new CronJob(this.cronExpression, () => this.runCleanup());
  this.schedulerRegistry.addCronJob('challenge-cleanup', job);
  job.start();
}
```

`SchedulerRegistry` is injected in the constructor alongside `PrismaService` and `ConfigService`.

The cleanup logic:

```typescript
async runCleanup(): Promise<void> {
  try {
    const now = new Date();
    const retentionCutoff = new Date(now.getTime() - this.usedRetentionMs);

    const result = await this.prisma.walletChallenge.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { usedAt: { lt: retentionCutoff } },
        ],
      },
      // Prisma deleteMany does not support take natively; see workaround below
    });

    if (result.count > 0) {
      this.logger.log(`Challenge cleanup: deleted ${result.count} stale rows`);
    }
  } catch (err) {
    this.logger.error("Challenge cleanup failed", { error: err });
    // Do not rethrow — cron schedule must continue (Requirement 4.6)
  }
}
```

**Batch size note**: Prisma's `deleteMany` does not support `take` directly. The bounded delete is implemented using a subquery pattern:

```typescript
// Fetch IDs first, then delete by ID list
const ids = await this.prisma.walletChallenge.findMany({
  where: {
    OR: [
      { expiresAt: { lt: now } },
      { usedAt: { lt: retentionCutoff } },
    ],
  },
  select: { id: true },
  take: this.batchSize,
  orderBy: { createdAt: "asc" },
});

if (ids.length === 0) return; // Requirement 4.5 — no write when nothing to clean

await this.prisma.walletChallenge.deleteMany({
  where: { id: { in: ids.map((r) => r.id) } },
});
```

This ensures at most `batchSize` rows are touched per run regardless of how large the table grows.

---

### 6. AuthService Integration

`AuthService` is updated to inject `RateLimitService` and `AuditService`. The existing logic is preserved; audit calls are added at outcome points:

```typescript
async createChallenge(walletAddress: string) {
  this.assertValidPublicKey(walletAddress);
  // ... existing create logic ...
  // After successful create:
  this.auditService.logChallengeCreated(challenge.id, walletAddress);
  return challenge;
}

async verifyChallenge(input: { challengeId: string; walletAddress: string; signature: string }) {
  this.assertValidPublicKey(input.walletAddress);

  const challenge = await this.prisma.walletChallenge.findFirst({ ... });

  if (!challenge) {
    this.auditService.logLoginFailed({ walletAddress: input.walletAddress, reason: "challenge_unavailable" });
    throw new UnauthorizedException("Challenge is expired or unavailable");
  }

  const isValid = this.verifySignature(...);
  if (!isValid) {
    this.auditService.logLoginFailed({ walletAddress: input.walletAddress, reason: "invalid_signature", resourceId: challenge.id });
    throw new UnauthorizedException("Invalid wallet signature");
  }

  // ... upsert user, mark challenge used ...
  this.auditService.logLoginSuccess(user.id, input.walletAddress);
  return { user, session };
}
```

The `RateLimitGuard` handles rate-limit checking before the service method is called, so `AuthService` itself does not need to call `RateLimitService` directly. The guard calls `auditService.logLoginFailed({ reason: 'rate_limited', walletAddress })` before throwing 429.

---

## Data Models

The `AuditLog` Prisma model requires one additive change: a new `actorHash` field to hold the hashed wallet address without conflicting with the existing `actorId` FK to `User.id`. All other existing fields are reused as-is.

### Prisma schema change

```prisma
model AuditLog {
  id           String   @id @default(cuid())
  actorType    String
  actorHash    String?  // sha256(walletAddress) — privacy-safe identifier; no FK constraint
  actorId      String?  // FK to User.id — populated only when actor is a known User
  actor        User?    @relation(fields: [actorId], references: [id])
  action       String
  resourceType String
  resourceId   String?
  metadata     Json?
  createdAt    DateTime @default(now())

  @@index([actorType, actorHash])
  @@index([actorType, actorId])
  @@index([resourceType, resourceId])
  @@index([createdAt])
}
```

A Prisma migration must be generated and applied to add the `actorHash` column.

### Field mapping for auth events

| Field          | Value for auth events                                |
|---------------|------------------------------------------------------|
| `actorType`   | `"wallet"`                                           |
| `actorHash`   | `sha256(walletAddress)` (never raw; no FK constraint)|
| `actorId`     | `userId` for `auth.login.success`; `null` otherwise  |
| `action`      | `"auth.challenge.created"` / `"auth.login.success"` / `"auth.login.failed"` |
| `resourceType`| `"WalletChallenge"` or `"User"`                      |
| `resourceId`  | challenge id, user id, or `null` (rate_limited path) |
| `metadata`    | `null` or `{ "reason": "..." }`                      |

---

## Environment Variables

### New Variables

| Variable                              | Type    | Default  | Validation         |
|---------------------------------------|---------|----------|--------------------|
| `AUTH_CHALLENGE_RATE_LIMIT_MAX`       | integer | `10`     | positive integer   |
| `AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS` | integer | `60` | positive integer   |
| `AUTH_VERIFY_RATE_LIMIT_MAX`          | integer | `5`      | positive integer   |
| `AUTH_VERIFY_RATE_LIMIT_WINDOW_SECONDS` | integer | `60`   | positive integer   |
| `CHALLENGE_CLEANUP_INTERVAL_CRON`    | string  | `0 * * * *` | deferred to `CronJob` constructor (throws on invalid expression at service init) |
| `CHALLENGE_CLEANUP_BATCH_SIZE`       | integer | `500`    | positive integer   |
| `CHALLENGE_USED_RETENTION_SECONDS`   | integer | `86400`  | positive integer (1 day) |

### env.validation.ts Changes

The four rate-limit variables and three cleanup variables are added to the Zod schema using `z.coerce.number().int().positive()` with `.default()` values. Non-positive values cause a startup error (Requirement 3.3).

### configuration.ts Changes

A new `auth` section is added. It reads from `process.env` directly with inline `??` fallbacks, consistent with the existing pattern in the file. The Zod schema in `env.validation.ts` guarantees valid values are present at startup, so the fallbacks are a safety net rather than the primary default mechanism:

```typescript
auth: {
  challenge: {
    rateLimitMax: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 10),
    rateLimitWindowSeconds: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS ?? 60),
  },
  verify: {
    rateLimitMax: Number(process.env.AUTH_VERIFY_RATE_LIMIT_MAX ?? 5),
    rateLimitWindowSeconds: Number(process.env.AUTH_VERIFY_RATE_LIMIT_WINDOW_SECONDS ?? 60),
  },
  cleanup: {
    intervalCron: process.env.CHALLENGE_CLEANUP_INTERVAL_CRON ?? '0 * * * *',
    batchSize: Number(process.env.CHALLENGE_CLEANUP_BATCH_SIZE ?? 500),
    usedRetentionSeconds: Number(process.env.CHALLENGE_USED_RETENTION_SECONDS ?? 86400),
  },
},
```

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Redis unreachable during rate-limit check | Allow request; log warning at `warn` level |
| Redis unreachable during INCR/EXPIRE | Caught in try/catch; allow proceeds |
| AuditLog write fails | `.catch()` swallows; log error; primary response unaffected |
| ChallengeCleanup DB error | Caught in try/catch; log error; cron continues |
| Invalid wallet address | `BadRequestException` (unchanged) |
| Expired or used challenge | `UnauthorizedException` + `logLoginFailed` |
| Invalid signature | `UnauthorizedException` + `logLoginFailed` |
| Rate limit exceeded | `HttpException(429)` + `logLoginFailed({ reason: 'rate_limited', ... })` |

---

## Testing Strategy

### Unit Tests

Each new service gets a dedicated `.spec.ts` using Jest with mocked dependencies:

- `rate-limit.service.spec.ts` — mocks ioredis `Redis` class; tests counter increment, limit enforcement, TTL calculation, Redis-failure pass-through.
- `audit.service.spec.ts` — mocks `PrismaService`; verifies field values for each event type, verifies errors are swallowed.
- `challenge-cleanup.service.spec.ts` — mocks `PrismaService`; verifies findMany + deleteMany pattern, batch size, empty-result path, error-swallowing.
- `auth.service.spec.ts` — extended to inject mock `AuditService`; verifies audit calls on success/failure paths; verifies service still returns token when AuditService throws.

### Integration Points

`RateLimitGuard` is tested via `auth.controller.spec.ts` using the NestJS testing module with a mock `RateLimitService`, verifying 429 shape and that the guard short-circuits before `AuthService` is called.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Rate-limit key derivation never exposes raw wallet address

*For any* valid Stellar wallet address string, the Redis key used by RateLimitService must equal `"rl:{namespace}:" + sha256(walletAddress)` and must NOT contain the raw wallet address string anywhere in the key.

**Validates: Requirements 1.1, 2.1**

---

### Property 2: Rate-limit enforcement threshold

*For any* configured throttle limit N ≥ 1 and any wallet address, exactly the first N requests within the window are allowed; the (N+1)th and all subsequent requests within the same window are rejected with a 429 response containing a non-negative `retryAfter` field.

**Validates: Requirements 1.2, 1.3, 2.2, 2.5**

---

### Property 3: Redis key namespace isolation

*For any* wallet address, the Redis key produced by RateLimitService for the `challenge` namespace must differ from the key produced for the `verify` namespace, and both must be distinct from any key that does not begin with the `rl:` prefix.

**Validates: Requirements 1.4**

---

### Property 4: Non-positive rate-limit env vars are rejected at startup

*For any* value ≤ 0 supplied for `AUTH_CHALLENGE_RATE_LIMIT_MAX`, `AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS`, `AUTH_VERIFY_RATE_LIMIT_MAX`, or `AUTH_VERIFY_RATE_LIMIT_WINDOW_SECONDS`, the environment validation schema must throw a validation error before the application accepts any requests.

**Validates: Requirements 3.3**

---

### Property 5: Redis failure allows request through

*For any* wallet address and any endpoint, if the Redis client throws during a rate-limit check, the RateLimitService must return `{ allowed: true }` and emit at least one `warn`-level log entry, never propagating the error to the caller.

**Validates: Requirements 1.6, 2.4**

---

### Property 6: Cleanup batch size is always respected

*For any* positive cleanup batch size N, a single execution of ChallengeCleanupService must perform at most N row deletions regardless of how many stale rows exist in the WalletChallenge table.

**Validates: Requirements 4.3**

---

### Property 7: Cleanup log message reflects actual deletion count

*For any* positive integer count C of stale rows deleted in a single cleanup execution, the service must emit exactly one log message that includes C, and must emit no such log message when C is zero.

**Validates: Requirements 4.7, 4.5**

---

### Property 8: Audit actorHash is always the hashed wallet address

*For any* wallet address W and any AuditService method invocation, the `actorHash` stored in the resulting AuditLog row must equal `sha256(W)` and must not equal `W` itself. The `actorId` field must be null for all events except `auth.login.success`, where it must equal the associated `userId`.

**Validates: Requirements 5.6, 5.7**

---

### Property 9: Audit fields are correct for all auth outcomes

*For any* auth event (challenge created, login success, login failed with any sub-reason), the AuditLog row written by AuditService must contain the exact `action`, `actorType`, `actorHash`, `resourceType`, `resourceId`, and `metadata` values prescribed by the requirements for that outcome. In particular, the `resourceId` for a `rate_limited` failure must be null.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

---

### Property 10: Audit and rate-limit failures do not block successful auth

*For any* valid authentication input, if AuditService.write() throws an error, AuthService must still return the correct session token to the caller. Similarly, if RateLimitService throws an unhandled exception (not a rate-limit rejection), AuthService must proceed as if the request is not rate-limited.

**Validates: Requirements 6.1, 6.2**
