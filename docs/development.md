# Development database tooling

How to fill a local database with usable data, how to empty it, and what stops
either of those happening to a database you did not mean.

For the fixtures themselves — what the builders produce and why they look the
way they do — see [test data and demo factories](test-data.md). For the
integration suite's own disposable databases, see
[integration testing](integration-testing.md).

## The three entry points

| Command | Writes | Guarded by |
|---|---|---|
| `npx prisma db seed` (`prisma/seed.ts`) | Reference data only: supported assets | Nothing — every environment needs these rows |
| `npm run seed:demo` (`prisma/seed-demo.ts`) | A full synthetic scenario: users, organizations, issuers, payments, proofs, API keys, webhooks, deliveries, anchoring intents | `assertSeedAllowed` |
| `npm run db:reset` (`prisma/reset.ts`) | Nothing. **Empties every application table** | `assertResetAllowed`, plus a typed confirmation |

They are separate files on purpose. The reference seed is safe everywhere and
must stay that way; the demo seed writes fabricated records that no shared
environment should ever contain, and a single entry point would eventually pull
one into the other.

## Seeding a local database

```bash
docker compose up -d postgres
npx prisma migrate dev
npm run seed:demo
```

The demo seed is idempotent: every write is an upsert keyed on a deterministic
synthetic id, so running it three times produces the same rows as running it
once. That is what makes it safe to re-run after an interrupted attempt, and it
is asserted against real PostgreSQL in
[`test/integration/seed-reset.int-spec.ts`](../test/integration/seed-reset.int-spec.ts).

The run ends by reading back what is present. If rows are missing — a previous
run was interrupted, or something deleted them — it prints the classes that are
short and exits non-zero:

```
Seed is incomplete:
  - proofs: expected 4, found 3
  - deliveries: expected 3, found 0
```

Running it again is the repair. The writes follow the foreign-key graph — users,
then the organizations they create, then everything hanging off those — so an
interrupted run leaves a *prefix* of the graph, never a dangling reference.

### What the scenario contains

One of every state the application distinguishes, including the awkward ones:
an expired proof, a revoked proof, an unanchored proof, a suspended user, a
suspended and a revoked issuer, an expired and a revoked API key, a failed and a
pending webhook delivery, and a permanently failed anchoring intent. The point
is that nobody has to hand-build those, because hand-built fixtures reliably get
the happy path right and the failure states wrong.

### Synthetic-data guarantees

The fixtures are deliberately impossible to mistake for real data, and the tests
enforce it rather than the convention:

- Wallet and payment addresses are Stellar-*shaped* but fail the checksum, so
  they can never address a real account, and they carry a grep-able `SYNTHETIC`
  marker.
- Webhook URLs point at `.example.invalid`, which RFC 2606 guarantees can never
  resolve.
- No plaintext amount is ever written. The schema stores `amountEncrypted`, and
  the seed leaves it empty rather than modelling a privacy boundary the
  application does not have.
- Nothing is copied from a real wallet, credential, or payment. Every value is
  derived from a seed string by hash.

## Resetting a local database

```bash
CONFIRM_RESET=earnproof_dev npm run db:reset
```

This truncates every application table and leaves the schema and Prisma's
migration ledger in place, so the database stays at its current migration and
can be re-seeded immediately. It is safe to run twice; the second run finds
nothing and says so.

It reports what it destroyed, per table, as counts:

```
Reset "earnproof_dev": 21 tables, 34 rows removed.
  - User: 4
  - Organization: 2
```

### The guards

`assertResetAllowed` refuses, in this order:

1. `NODE_ENV=production` — refused outright. No override lifts this.
2. A missing or unparseable `DATABASE_URL` — an unknown target is not a safe
   one.
3. A database whose name does not contain `test`, `dev`, `development` or
   `local` — refused unless `ALLOW_DESTRUCTIVE_RESET=true`.
4. A host that is not recognised as local (`localhost`, `127.0.0.1`, `::1`,
   `host.docker.internal`, `postgres`, `db`) — refused unless
   `ALLOW_DESTRUCTIVE_RESET=true`.
5. `CONFIRM_RESET` must equal the target database's name.

The confirmation is the check that catches what the others cannot. `NODE_ENV`
and the host say what *kind* of environment this is; only the database name says
*which* one, and the realistic accident is a correct command aimed at the wrong
database — a shell still holding staging's `DATABASE_URL`, or a `.env` loaded
from the wrong directory. Typing the name is the smallest thing that makes the
operator look at the target.

`ALLOW_DESTRUCTIVE_RESET` exists for CI containers and disposable review
environments, whose hostnames are not local. It cannot bypass the production
check, and it cannot bypass the confirmation.

Refusal messages name the host and the database but never the connection string,
because a safety message that prints a password is a credential leak in a
terminal people paste into issues.

The demo seed's own guard, `assertSeedAllowed`, is the same idea one notch
looser: seeding adds fabricated rows rather than destroying real ones, so it
requires no confirmation, and its override is `ALLOW_SYNTHETIC_SEED=true`.

## Where the tests are

| Property | Test |
|---|---|
| Guard refuses production, unknown targets, wrong confirmation | [`src/testing/reset/database-reset.spec.ts`](../src/testing/reset/database-reset.spec.ts) |
| Seed guard, factory determinism, referential integrity of the fixture | [`src/testing/factories/factories.spec.ts`](../src/testing/factories/factories.spec.ts) |
| Repeatability, schema constraints, partial-failure detection, reset behaviour | [`test/integration/seed-reset.int-spec.ts`](../test/integration/seed-reset.int-spec.ts) |

The first two need no database. The third runs against a disposable PostgreSQL
database created per Jest worker (`npm run test:integration`).
