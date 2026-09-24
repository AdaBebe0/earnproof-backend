# ADR-0002: Prisma as the data access layer

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The domain has genuine relational structure — organizations own issuers and API
keys, users own payments and proofs, proofs own claims and anchoring intents.
Several invariants are enforceable in the schema itself: `Payment.operationId`
must be unique for sync idempotency, `Proof.credentialHash` must be unique so no
two proofs share a credential.

We needed those constraints in the database, not only in application code.

## Decision

Prisma as the ORM, with [`prisma/schema.prisma`](../../prisma/schema.prisma) as
the single schema definition. Lifecycle in
[`src/database/prisma.service.ts`](../../src/database/prisma.service.ts).
Migrations are checked in.

## Consequences

**Easier.** Unique constraints and relations are declared once and enforced by
Postgres, so invariants I8, I13, and I18 hold even if application code is wrong.
Generated types mean a schema change surfaces as a compile error. `$transaction`
gives a clear atomicity boundary.

**Harder.** Complex queries are more awkward than raw SQL, and `$queryRaw`
escapes the type system when reached for. The generated client must be
regenerated after a schema change, which is why `build` runs `prisma generate`
first. Prisma's own errors leak schema detail, which is why
[`global-exception.filter.ts`](../../src/common/filters/global-exception.filter.ts)
maps them rather than passing them through.

**Ruled out.** Swapping the ORM cheaply — Prisma types reach into every service.

## Alternatives considered

**TypeORM.** Viable, and closer to Nest's conventions. Rejected for weaker
migration ergonomics and less precise generated types.

**Raw SQL with a query builder.** Rejected: it would put every relational
constraint in application code, where a missed check becomes a data-integrity
bug rather than a failed insert.
