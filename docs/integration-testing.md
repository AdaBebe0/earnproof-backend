# PostgreSQL Integration Tests

The unit suite runs against a mocked Prisma client. That makes it fast, and it
is the right trade for logic — but a mock accepts every write, so it cannot tell
you whether a migration applies, whether a unique index exists, whether a
`$transaction` actually rolls back, or what two concurrent writers see. Those
are properties of PostgreSQL, and the only way to test them is to use
PostgreSQL.

This suite does. It applies **every production migration to an empty database**,
then exercises proof issuance and revocation, webhook retry persistence,
authentication sessions, payment uniqueness, transaction commit and rollback,
constraint violations, and concurrent writes.

```bash
npm run test:integration
```

## What you need

- PostgreSQL 17 running locally (the version CI and `docker-compose.yml` use).
- A role that can log in **and create databases**.
- `TEST_DATABASE_URL` pointing at that role.

Docker is not required. If you already run the Compose stack, the Postgres
service it starts works too — it is just a PostgreSQL server.

### One-time setup

Run this as a superuser (`psql -U postgres`):

```sql
CREATE ROLE earnproof WITH LOGIN PASSWORD 'earnproof' CREATEDB;
```

If the role already exists without `CREATEDB`:

```sql
ALTER ROLE earnproof WITH CREATEDB;
```

Then set the target, in `.env` or your shell:

```bash
TEST_DATABASE_URL=postgresql://earnproof:earnproof@localhost:5432/earnproof_test
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL='postgresql://earnproof:earnproof@localhost:5432/earnproof_test'
```

`CREATEDB` is the only privilege beyond ordinary login that the harness needs.
It never touches a database outside the ones it creates.

### The database in the URL is not used

`earnproof_test` in that URL is a **naming base**, not a target. The harness
never connects to it, and it does not need to exist. It derives two kinds of
database from the name:

| Database | Created by | Contains |
|---|---|---|
| `earnproof_test_template` | global setup, once per run | the schema, built by `prisma migrate deploy` |
| `earnproof_test_w1`, `_w2`, … | each Jest worker, on first use | a clone of the template |

Both are dropped in global teardown. Pointing `TEST_DATABASE_URL` at an existing
database therefore cannot destroy it.

## How the harness works

### Migrations, not `db push`

Global setup drops the template, recreates it empty, and runs
`prisma migrate deploy`. It then checks the `_prisma_migrations` ledger records
every directory under `prisma/migrations` as applied, and that the resulting
schema matches `prisma/schema.prisma` with no drift.

`prisma db push` would have been faster and would have hidden the two failures
this is here to catch: a migration that cannot apply from empty, and a model
edited in `schema.prisma` with no migration behind it. The second is the
dangerous one — the generated client still works, so every unit test passes
while production is one release away from a column that does not exist.

The template is rebuilt every run rather than reused. A reused template makes
the suite depend on whatever the last run left behind, which is the
non-determinism this harness exists to remove.

### Isolation: a database per worker, truncation per test

Each Jest worker gets its own database, cloned from the template.
`CREATE DATABASE ... TEMPLATE` is a file copy inside PostgreSQL, so a worker is
ready in milliseconds without replaying the migration history. Workers never
share a database, which is what makes the suite parallel-safe — and it runs in
parallel by default, so a test that leaks state fails here rather than surviving
until someone drops `--runInBand`.

Between tests every application table is truncated in one
`TRUNCATE … RESTART IDENTITY CASCADE`. One statement takes all the locks at
once, so it cannot deadlock against itself and does not need foreign-key order
maintained by hand. The table list is read from the database, so a table added
by a migration is truncated without anyone editing the harness.

`_prisma_migrations` is excluded: truncating it would leave a database that
looks unmigrated to the next `migrate deploy`.

**Why not wrap each test in a rolled-back transaction?** It is faster, but it
makes the code under test run inside a transaction it did not open — which
silently breaks every test of transaction behaviour, and this suite exists
largely to test transaction behaviour.

### Bounded startup and teardown

Every step that talks to PostgreSQL or spawns the Prisma CLI has a deadline.
Without one, an unreachable host, a server that accepts the socket and goes
quiet, or a `DROP DATABASE` blocked behind a leaked connection all present the
same way: a CI job that hangs until the runner kills it, with no output naming
the step that stalled.

| Setting | Default | Bounds |
|---|---|---|
| `INTEGRATION_ADMIN_TIMEOUT_MS` | 15000 | connect, create, drop, truncate |
| `INTEGRATION_MIGRATE_TIMEOUT_MS` | 120000 | `prisma migrate deploy`, `migrate diff` |
| `INTEGRATION_TEST_TIMEOUT_MS` | 30000 | one test |

Teardown never fails the run. The tests have already reported their verdict, and
reporting a cleanup problem as a test failure helps nobody; the next run's setup
drops the leftovers anyway.

Set `INTEGRATION_KEEP_DATABASES=true` to keep the databases for inspection after
a failure.

### Redaction of test failures

Test output is the least guarded surface in the system. It lands in CI logs, in
terminal scrollback, and pasted into issues — and a failure in *this* suite is
assembled from real material: a live connection string, an encrypted amount, a
session token minted seconds earlier.

Two redaction points cover the two ways that material escapes:

1. **The database client.** Every Prisma rejection is redacted at the client
   boundary, where Prisma attaches the datasource and the failing query. The
   error object is mutated rather than replaced, so `instanceof` and
   `error.code` keep working and tests can still assert on `P2002`.

2. **Assertions.** `expect(row).toEqual(expected)` prints both objects, so any
   mismatch on a `Payment` prints `amountEncrypted` and any mismatch on an
   `AuthSession` prints `tokenHash`. No care inside a test prevents that,
   because the value is printed by the matcher.

Covered: connection strings (credentials included), wallet addresses, Stellar
secret seeds, `enc:v1:` protected amounts, `sha256:` credential and wallet
hashes, opaque session tokens, webhook signing secrets, and the literal values
of known-sensitive environment variables.

Deliberately preserved: line structure, message length, and counts such as
`attempt 3 of 5`. A clipped or reflowed diff hides the mismatch it was printed
to show. This is why the harness does not reuse
[`src/common/observability/redaction.ts`](../src/common/observability/redaction.ts),
which collapses whitespace and truncates at 512 characters because it is tuned
for a single log line.

## Writing a test

```ts
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { seedUser, seedPayment } from "./harness/fixtures";
import { SessionService } from "../../src/auth/session.service";

const db = integrationDatabase();                    // must come first
const module = integrationModule([SessionService]);

it("stores only a hash of the token", async () => {
  const user = await seedUser(db.prisma, "example");
  const { token } = await module.get(SessionService).create({ ...user });

  const row = await db.prisma.authSession.findFirstOrThrow();
  expect(JSON.stringify(row)).not.toContain(token);
});
```

`integrationDatabase()` registers the hooks that create, clean, and disconnect
from the worker database, so it must be called before `integrationModule()` —
Jest runs `beforeAll` hooks in registration order, and the module's providers
connect to a database that must already exist.

`integrationModule()` builds a narrow Nest injector rather than booting
`AppModule`: the full application starts the scheduler, the anchoring worker and
the webhook delivery queue, which is background work with timers and outbound
HTTP that has nothing to do with the behaviour under test and everything to do
with a suite that hangs on teardown.

Fixtures build on
[`src/testing/factories`](../src/testing/factories/index.ts) — the same
deterministic, unmistakably-synthetic values documented in
[`docs/test-data.md`](test-data.md) — and insert them through the application's
own encryption, so a row written by a test is indistinguishable from one written
by a service.

## Files

| Path | Role |
|---|---|
| [`jest.integration.config.js`](../jest.integration.config.js) | runner: match, setup, teardown |
| [`test/integration/harness/config.ts`](../test/integration/harness/config.ts) | target resolution and the refusals |
| [`test/integration/harness/global-setup.ts`](../test/integration/harness/global-setup.ts) | build and migrate the template |
| [`test/integration/harness/database.ts`](../test/integration/harness/database.ts) | per-worker database, truncation, client redaction |
| [`test/integration/harness/redaction.ts`](../test/integration/harness/redaction.ts) | what never reaches test output |
| [`test/integration/harness/fixtures.ts`](../test/integration/harness/fixtures.ts) | persistence helpers and constraint assertions |
| [`test/integration/harness/global-teardown.ts`](../test/integration/harness/global-teardown.ts) | drop everything the run created |

## Troubleshooting

**`TEST_DATABASE_URL is not set`** — see [One-time setup](#one-time-setup). It is
deliberately separate from `DATABASE_URL` so a development database can never be
the target.

**`TEST_DATABASE_URL names a database without "test" in it`** — the harness
creates, truncates and drops databases derived from this name and refuses any
target that is not obviously disposable. Rename the database.

**`permission denied to create database`** — the role lacks `CREATEDB`:
`ALTER ROLE <role> WITH CREATEDB;`

**`Connecting to the maintenance database did not finish within 15000ms`** —
PostgreSQL is not accepting connections on that host and port, or a firewall is
swallowing them. Check the server is running before raising the timeout.

**`source database is being accessed by other users`** — a previous run left a
connection open. Re-running clears it: setup drops stale worker databases before
cloning the template.
