# Spec Readiness Review: Auth Rate Limits, Challenge Cleanup, and Persistent Audit Events

This is a final readiness review of three spec documents — `requirements.md`, `design.md`, and `tasks.md` — prior to implementation. The spec covers a Redis-backed fixed-window rate limiter, a bounded `WalletChallenge` cleanup cron job, and a fire-and-forget `AuditService` writing privacy-safe rows to the existing `AuditLog` table. The three documents are well-aligned. Two issues must be fixed before implementation: a type-casting gap in `configuration.ts` that will silently produce string values where numbers are expected at runtime, and an incorrect description of where `CronJob` is imported from — the spec omits `cron` from the install steps entirely.

**Watch for:** (1) `configuration.ts` reads `process.env.*` without `Number()` — numeric config values will be strings at runtime, causing rate-limit comparisons to misfire and Prisma's `take` to receive a string. (2) The spec says `CronJob` is "re-exported by `@nestjs/schedule`" — it is not; `cron` must be installed as a direct dependency and is missing from the task install steps.

**Verdict**: NEEDS_CHANGES

---

## High-level view

The `configuration.ts` pattern throughout this codebase applies `Number()` to every numeric config value. The spec's new `auth` section omits this for all six numeric fields, so `rateLimitMax`, `rateLimitWindowSeconds`, `batchSize`, and `usedRetentionSeconds` will be strings at runtime in any real deployment where the env vars are set. The comparison `count > options.limit` in `RateLimitService` will coerce unpredictably; `take: this.batchSize` will fail at the Prisma call site. Zod validates the env vars but `configuration.ts` re-reads from `process.env` directly and never sees the coerced Zod output.

`@nestjs/schedule` does not publicly re-export `CronJob`. The correct import is `from 'cron'`, and `cron` is a peer dependency of `@nestjs/schedule` — it must be installed and pinned explicitly. The tasks notes list `@nestjs/schedule@5.0.1` but omit `cron`. The programmatic registration approach itself (`SchedulerRegistry.addCronJob` in `onModuleInit`) is correct; only the import description and install instructions are wrong.

The `runCleanup` code sample in the design uses `{ usedAt: { not: null, lt: retentionCutoff } }`. Prisma does not support two predicates as sibling keys in the same field filter — the valid form is `{ usedAt: { lt: retentionCutoff } }` (the `not: null` check is redundant since `lt` on a null field never matches). An implementer copying the design sample verbatim will encounter a Prisma client type error.

Task 8.2's fifth test ("Verify AuthService still returns session token when `AuditService` throws") needs clarification: since all `AuditService` methods are `void` (fire-and-forget), the meaningful failure mode is a synchronous throw from `write()` before the promise is created, not a rejected promise. The test should explicitly mock `logLoginSuccess` to throw synchronously and assert `verifyChallenge` still resolves.

The tasks notes section contains a stale cross-reference: "add `actorHash String?` (task 8.3)". Task 8.3 does not exist; the migration is task 1.4.

---

<details>
<summary>Issues (5)</summary>

1. **BLOCKER: `configuration.ts` numeric fields missing `Number()` cast** — All six new numeric fields in the `auth` section are read from `process.env` and returned without `Number()`. At runtime they will be strings in any deployment where the env vars are set. `count > options.limit` in `RateLimitService` will misfire (numeric-vs-string coercion), and `take: this.batchSize` in `findMany` will fail at the Prisma call site. Fix: wrap all six numeric reads with `Number(...)`, matching the existing pattern used for `port` and `schemaVersion`.

2. **BLOCKER: `CronJob` import source is incorrect / `cron` not in install steps** — The design says `CronJob` is "from the `cron` package, re-exported by `@nestjs/schedule`". `@nestjs/schedule` does not re-export `CronJob`. The correct import is `import { CronJob } from 'cron'`, and `cron` must be installed as a direct dependency. The tasks notes list `@nestjs/schedule@5.0.1` but omit `cron`. Add `npm install cron@3.x.x` (pinned) to the task 6 install instructions and correct the import description in the design.

3. **ADVISORY: Invalid Prisma filter syntax in `runCleanup` code sample** — The design uses `{ usedAt: { not: null, lt: retentionCutoff } }`. Prisma does not allow `not` and `lt` as sibling keys on the same field object. Use `{ usedAt: { lt: retentionCutoff } }` — `lt` on a null field never matches so the `not: null` guard is redundant. An implementer copying this sample verbatim will get a TypeScript error at the Prisma call site.

4. **ADVISORY: Stale cross-reference in tasks notes** — The notes section says "The `AuditLog` Prisma model requires one additive change: add `actorHash String?` (task 8.3)". Task 8.3 does not exist; the migration is task 1.4.

5. **ADVISORY: Property test 8.2 under-specifies synchronous-throw case** — Task 8.2 says "Verify AuthService still returns session token when `AuditService` throws". Since `AuditService` methods are `void` fire-and-forget, the test must mock `logLoginSuccess` to throw synchronously (not reject a promise) and assert `verifyChallenge` still resolves. The current description does not specify this, leaving the test implementation ambiguous.

</details>

<details>
<summary>Details</summary>

### `configuration.ts` type gap — numeric env vars returned as strings

The existing codebase applies `Number()` to every numeric config value: `port: Number(process.env.PORT ?? 4000)` and `schemaVersion: Number(process.env.EARNPROOF_SCHEMA_VERSION ?? 1)`. The spec's proposed `auth` section breaks this pattern:

```typescript
// As specified in design.md — WRONG
rateLimitMax: process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 10,
rateLimitWindowSeconds: process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS ?? 60,
batchSize: process.env.CHALLENGE_CLEANUP_BATCH_SIZE ?? 500,
usedRetentionSeconds: process.env.CHALLENGE_USED_RETENTION_SECONDS ?? 86400,

// Correct — matching existing codebase pattern
rateLimitMax: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 10),
rateLimitWindowSeconds: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS ?? 60),
batchSize: Number(process.env.CHALLENGE_CLEANUP_BATCH_SIZE ?? 500),
usedRetentionSeconds: Number(process.env.CHALLENGE_USED_RETENTION_SECONDS ?? 86400),
```

When an env var is set, `process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX` is the string `"10"`. The `??` fallback's numeric literal is only used when the variable is absent entirely — so in every real deployment where env vars are configured, the value will be a string. The `count > options.limit` comparison in `RateLimitService.check()` then operates as `number > string`; JavaScript coerces but produces undefined behaviour at edge values. Prisma's `take` option is typed as `number`; passing a string causes a runtime Prisma client error.

The `env.validation.ts` Zod schema uses `z.coerce.number()` and produces real numbers, but `configuration.ts` re-reads from `process.env` independently and never consumes the Zod-coerced output. TypeScript will also not catch this: the inferred type of `process.env.FOO ?? 10` is `string | number`, which is assignable to `number` only with a cast — the TypeScript compiler won't flag it without a stricter config.

---

### `CronJob` import and `cron` package installation

`@nestjs/schedule` exports `SchedulerRegistry`, `@Cron()`, `@Interval()`, and related schedule decorators. It does not publicly export `CronJob`. The implementation must import it directly:

```typescript
import { CronJob } from 'cron';
```

`@nestjs/schedule@5.x` declares `cron@3.x` as a peer dependency. Peer dependencies are not automatically installed — they must be added explicitly to `dependencies` in `package.json`. The current task notes read:

> Add `@nestjs/schedule` as a pinned dependency: `npm install @nestjs/schedule@5.0.1`

This must be extended to:

> `npm install @nestjs/schedule@5.0.1 cron@3.x.x` (pin `cron` to the exact version peer-required by `@nestjs/schedule@5.0.1`)

Without the explicit `cron` install, the package may be present transitively (npm may hoist it) but at an unpinned version, making the installation non-reproducible across environments. The `CronJob` constructor signature changed between cron v2 and v3, so an accidental version mismatch would cause a runtime error in `onModuleInit`.

---

### Prisma `usedAt` filter syntax

The `runCleanup` code sample in the design specifies:

```typescript
{
  usedAt: { not: null, lt: retentionCutoff }
}
```

Prisma's generated `WhereInput` types do not allow `not` and `lt` as sibling keys inside a single field filter object. Prisma's field filter for a nullable `DateTime?` accepts either a `DateTimeFilter` (with `lt`, `gt`, etc.) or `{ not: null }`, but not both in the same object. The correct form is simply:

```typescript
{ usedAt: { lt: retentionCutoff } }
```

A `DateTime?` field set to `null` will never satisfy `lt: retentionCutoff` for any non-null `retentionCutoff`, so the `not: null` guard is functionally redundant. Using the design sample as-is will produce a TypeScript compile error from the Prisma client types, or — if types are loose — a silent query that may not behave as intended.

---

### Property test coverage — synchronous-throw gap in test 8.2

Properties 1–10 in the design are all correctly specified and testable. The only implementation ambiguity is in task 8.2's fifth test case. `AuditService.logLoginSuccess()` is typed `void` — it returns nothing. The fire-and-forget pattern means the service starts a floating promise by calling `this.prisma.auditLog.create().catch(...)`. A test that mocks `logLoginSuccess` to `return Promise.reject(...)` would not exercise the right code path, because the method doesn't return a promise at all. The test mock must be:

```typescript
jest.spyOn(auditService, 'logLoginSuccess').mockImplementation(() => { throw new Error('audit fail'); });
```

The task description's current phrasing — "Verify AuthService still returns session token when `AuditService` throws" — is consistent with this, but an implementer might reasonably interpret "throws" as "rejects the returned promise" and write a mock that returns a rejected promise, which would pass trivially (since AuthService never awaits the audit call) without exercising the synchronous-throw path.

</details>

---

<details>
<summary>File map</summary>

Spec documents reviewed:

- `.kiro/specs/auth-rate-limits-and-audit-events/requirements.md` — complete and internally consistent; no issues
- `.kiro/specs/auth-rate-limits-and-audit-events/design.md` — one invalid Prisma filter code sample (`usedAt`); one incorrect CronJob import description
- `.kiro/specs/auth-rate-limits-and-audit-events/tasks.md` — missing `Number()` in `configuration.ts` example; missing `cron` install step; stale task 8.3 cross-reference; property test 8.2 ambiguous on synchronous-throw

Existing source files consulted:

- `prisma/schema.prisma` — `actorHash` absent from `AuditLog`; migration required as specified
- `src/config/configuration.ts` — `Number()` pattern confirmed for `port` and `schemaVersion`; absent from spec's proposed `auth` section
- `src/config/env.validation.ts` — `z.coerce.number()` pattern confirmed
- `src/auth/auth.service.ts` — no `AuditService` calls yet; structure consistent with integration plan
- `src/common/crypto/hash.ts` — `sha256()` utility present and reusable
- `src/auth/auth.module.ts` — no new providers yet
- `src/app.module.ts` — no `ScheduleModule` or `RedisModule` yet

</details>
