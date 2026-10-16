# Database Query-Plan and Performance Regression Tests

A query that is correct and fast against a development database with a
hundred rows can become unsafe in production, at real scale, without any code
changing at all — an index gets dropped in a later migration, a `WHERE`
clause grows a column the composite index does not lead with, someone
swaps cursor pagination for `OFFSET`. None of that fails a unit test, because
a mocked Prisma client accepts every query shape identically regardless of
what PostgreSQL's planner would actually do with it.

This suite catches that class of regression. It seeds a real PostgreSQL
database at meaningful scale, runs `EXPLAIN (ANALYZE, FORMAT JSON)` against
the exact SQL shape a handful of critical service methods issue, and asserts
on the plan: which index (if any) was used, whether a full table scan
occurred, and how expensive the planner considers the query.

```bash
npm run test:performance
```

## What this is not

This is not a load-testing or throughput benchmark suite, and it does not
replace `test/integration/`. It answers one narrow question per query: *at
scale, does PostgreSQL still use the index this query was designed around?*
Behavioural correctness (does the query return the right rows) is the
integration suite's job.

## Critical queries and their budgets

Every budget lives in [`test/performance/budgets.ts`](../test/performance/budgets.ts)
as a named constant with a provenance comment recording what was observed
when the budget was set. This table is a summary; the source file is the
source of truth.

| Category | Query | Service method | Index relied on |
|---|---|---|---|
| Auth | Session token validation | `SessionService#validate` (`src/auth/session.service.ts`) | `AuthSession_tokenHash_key` (unique) |
| Payment | Filtered, sorted payment history | `PaymentsService#listPayments` (`src/payments/payments.service.ts`) | `Payment_userId_occurredAt_idx` |
| Proof | Cursor-paginated proof history, deep page | `ProofsService#listProofs` (`src/proofs/proofs.service.ts`) | `Proof_userId_createdAt_id_idx` |
| Credential | Verification-time proof lookup | `CredentialsService#verifyCredential` (`src/credentials/credentials.service.ts`) | `Proof_credentialHash_key` (unique) |
| Job | Webhook retry sweep (runs at startup and on each retry tick) | `WebhookDeliveryService#onModuleInit` (`src/webhooks/webhook-delivery.service.ts`) | `WebhookDelivery_status_nextRetryAt_idx` |
| Job | Wallet challenge expiry sweep (daily cron) | `CleanupJob#cleanupChallenges` (`src/auth/cleanup.job.ts`) | `WalletChallenge_expiresAt_idx` |

Each spec file asserts three things about its query's plan:

1. **An index is used where one exists.** `summary.seqScannedRelations` must
   not contain the table — a regression to `Seq Scan` fails the test.
2. **No unbounded scan.** The plan's total-cost estimate and `EXPLAIN
   ANALYZE`'s wall-clock execution time must stay under the query's budget.
3. **The specific composite index is the one used**, not merely *an* index —
   a query that starts using a narrower, wrong index (e.g. `status` alone
   instead of `(status, nextRetryAt)`) can still avoid a seq scan while
   still being a regression.

N+1 behaviour is checked separately, statically, in
[`test/performance/n-plus-one.perf-spec.ts`](../test/performance/n-plus-one.perf-spec.ts) —
see [N+1 detection](#n1-detection) below.

## How to run the suite locally

The suite needs the same `TEST_DATABASE_URL` as `test/integration/` (see
[`docs/integration-testing.md`](integration-testing.md) for the one-time
role setup) — a PostgreSQL role with `CREATEDB`, pointed at a disposable
database name containing `test`.

```bash
export TEST_DATABASE_URL=postgresql://earnproof:earnproof@localhost:5432/earnproof_test
npm run test:performance
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL='postgresql://earnproof:earnproof@localhost:5432/earnproof_test'
npm run test:performance
```

The harness derives its own database name from this (`<base>_perf`, e.g.
`earnproof_test_perf`) — the same "the URL only supplies a naming base"
convention the integration harness uses, and for the same reason: it means
pointing this at an existing database cannot destroy its contents.

### What happens on a run

1. **Global setup** (`test/performance/harness/global-setup.ts`) drops and
   recreates `<base>_perf`, applies every migration in
   `prisma/migrations` with `prisma migrate deploy`, then seeds it with the
   scale fixture (below). This takes on the order of tens of seconds,
   dominated by inserting ~250,000 rows.
2. Every `*.perf-spec.ts` file connects to that one shared database and runs
   its `EXPLAIN` assertions read-only — nothing in the suite mutates the
   seeded rows (the wallet-challenge and webhook-delivery "sweep" queries
   are exercised as `SELECT`s mirroring the real `deleteMany`/`findMany`
   `WHERE` clause, specifically so a `DELETE` never runs against the shared
   fixture).
3. **Global teardown** drops `<base>_perf`.

The suite runs with a single Jest worker (`maxWorkers: 1` in
`jest.performance.config.js`): `EXPLAIN ANALYZE` timings are only meaningful
if nothing else is querying the same database at the same moment.

### If PostgreSQL is not available

Every spec file checks reachability in its own `beforeAll` and skips its own
assertions (each `it` returns immediately) rather than failing, and prints a
one-line warning naming this document. `npm run test:performance` therefore
exits 0 with no database configured — intentionally, so it is safe to wire
into a CI job that does not always have Postgres, without that job going red
for an environment reason unrelated to the code under test.

**This also means a green run is not proof the suite executed.** Check the
output for the "Skipping ... TEST_DATABASE_URL is not set" warnings, or for
the global-setup line reporting how many rows were seeded and how long it
took — that line only appears when a real database was actually used.

## Fixtures: how the scale data is built

[`test/performance/harness/scale-seed.ts`](../test/performance/harness/scale-seed.ts)
builds the fixture. Three properties make it representative of production
shape rather than just "a lot of rows":

- **Skewed tenant/user distribution.** A handful of "heavy" users
  (`DEFAULT_SCALE.heavyUserCount`, default 5) each hold thousands of
  payments and hundreds of proofs, while several thousand "regular" users
  hold a modest, uniform amount. This mirrors what an actual payroll or
  marketplace integration produces — a few very active accounts among many
  quiet ones — and it is deliberately not a uniform distribution: `WHERE
  userId = ? ORDER BY occurredAt` scans fine on a table where every user has
  forty rows regardless of whether the composite index exists, and only
  exposes a missing index once one user's slice is large enough that a
  sequential scan becomes visibly worse than an index scan.
- **Deep pagination.** Heavy users get enough rows (thousands of payments,
  over a thousand proofs) that a page 40 rows into a 20-row-per-page cursor
  walk is a real query against real intermediate data, not a first-page
  query that happens to return quickly because the whole table fits in one
  page.
- **Synthetic-only values.** Every identifier, wallet address, and hash
  comes from [`src/testing/factories/synthetic.ts`](../src/testing/factories/synthetic.ts) —
  the same deterministic, unmistakably-fake generator
  [`docs/test-data.md`](test-data.md) documents for the integration suite
  and demo seed. No field in the fixture can collide with, or be mistaken
  for, real user data.

### Regenerating the fixture

The fixture is rebuilt from scratch on every `npm run test:performance` run
(see [What happens on a run](#what-happens-on-a-run)) — there is nothing to
regenerate separately. To iterate faster while developing a new query test,
set `PERFORMANCE_SMOKE_SCALE=true` to seed the much smaller `SMOKE_SCALE`
(a few hundred users instead of a few thousand) — the plan shapes are the
same, just built and queried faster. Do not use smoke scale to validate a
budget number: `SMOKE_SCALE` is for iterating on test logic, and its row
counts are too small to reliably distinguish an index scan from a sequential
scan the way `DEFAULT_SCALE` can.

```bash
PERFORMANCE_SMOKE_SCALE=true npm run test:performance
```

`INTEGRATION_KEEP_DATABASES=true` (the same variable the integration harness
uses) leaves `<base>_perf` in place after the run instead of dropping it, so
`psql` or `prisma studio` can inspect the seeded data directly.

## Changing a budget

See the top of [`test/performance/budgets.ts`](../test/performance/budgets.ts)
for the full policy; summarized:

1. Run the suite (or paste CI's output) and include the new observed numbers
   in the PR.
2. State *why* the query legitimately changed — not "flaky," a real reason.
3. Get the change reviewed by someone other than the author.
4. Update the constant's provenance comment in the same PR.

Budgets are wide multiples of the observed baseline, not tight percentages,
because CI hardware differs from whatever machine took the baseline
measurement — they exist to catch order-of-magnitude regressions (a missing
index, an unbounded scan), not to micro-benchmark query latency.

## N+1 detection

[`test/performance/n-plus-one.perf-spec.ts`](../test/performance/n-plus-one.perf-spec.ts)
is a static check, not an `EXPLAIN`-based one — it runs unconditionally,
without a database, because "is there a per-item Prisma read inside a loop
body" is a property of the source code. It scans the payments, proofs, and
auth/credentials service files this issue scopes and fails if a
`findFirst`/`findUnique`/`findFirstOrThrow`/`findUniqueOrThrow` call appears
textually inside a `for`, `for...of`, `.forEach`, or `.map` body.

As part of building this suite, `src/payments/payments.service.ts` and
`src/proofs/proofs.service.ts` were reviewed for this pattern.

`src/proofs/proofs.service.ts` contains loops over payment arrays
(`createMinimumIncomeProof` and its recurring-proof counterpart), but in
each case the loop iterates over an array already fetched with a single
`findMany` — no query runs inside either loop body. No bug there.

**`src/payments/payments.service.ts`'s `syncPayments` did have a genuine N+1
bug**, found while building this suite: its `for (const payment of
incomingPayments)` loop called `this.prisma.payment.findUnique({ where: {
operationId } })` once per incoming payment to check whether the row already
existed, before `upsert`ing it. `incomingPayments` comes from Stellar
Horizon and can run into the hundreds for an active wallet, so a sync that
should have been a handful of queries was issuing one extra round trip to
the database per payment. This was fixed by batching the existence check
into a single `findMany({ where: { operationId: { in: [...] } } })` ahead of
the loop, and checking membership in the resulting `Set` inside it — same
behavior (the `created`/`updated` counts and every existing test are
unchanged), one query instead of N. See the diff in
`src/payments/payments.service.ts` (`syncPayments`) and the updated mocks in
`src/payments/payments.service.spec.ts` and
`src/payments/payments.horizon-sync.spec.ts`.

The per-row `upsert` itself still runs once per payment — that is not the
N+1 pattern this check targets (`upsert` has no Prisma-native batch form,
and each row's `create`/`update` payload genuinely differs), and it was left
as-is.

## Files

| Path | Role |
|---|---|
| [`jest.performance.config.js`](../jest.performance.config.js) | runner: match, setup, teardown, single-worker |
| [`test/performance/budgets.ts`](../test/performance/budgets.ts) | named budgets, provenance, change policy |
| [`test/performance/harness/config.ts`](../test/performance/harness/config.ts) | target resolution and the refusals |
| [`test/performance/harness/scale-seed.ts`](../test/performance/harness/scale-seed.ts) | the scale fixture |
| [`test/performance/harness/explain.ts`](../test/performance/harness/explain.ts) | `EXPLAIN (ANALYZE, FORMAT JSON)` execution and stable summarization |
| [`test/performance/harness/global-setup.ts`](../test/performance/harness/global-setup.ts) | build, migrate, and seed the shared database |
| [`test/performance/harness/global-teardown.ts`](../test/performance/harness/global-teardown.ts) | drop it |
| [`test/performance/harness/client.ts`](../test/performance/harness/client.ts) | per-test-file connection and the skip signal |
| [`test/performance/*.perf-spec.ts`](../test/performance/) | one file per query category |
