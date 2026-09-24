# Architecture decision records

Decisions that shaped the backend, why they were made, and what they cost.

An ADR records a decision that was not obvious at the time and would be
expensive to reverse. It is written so that someone arriving later can tell the
difference between a deliberate choice and an accident — the two look identical
in code.

## When a new ADR is required

Write one when a change:

- **adds an external dependency** the system now relies on to function;
- **changes a trust boundary** — makes an endpoint public, moves where auth is enforced, or alters what a caller must prove;
- **changes a data-protection rule** — what is hashed, encrypted, or logged;
- **crosses a module boundary** documented in [`../architecture.md`](../architecture.md), or moves a table's ownership;
- **changes a domain invariant**, particularly by weakening one;
- **picks between viable alternatives** where the losing option was defensible;
- **accepts a known risk** rather than fixing it.

Do **not** write one for a bug fix, a refactor that preserves behaviour, a
dependency bump, or a new endpoint that follows existing patterns. An ADR
directory full of routine changes is one nobody reads.

The test: *would a competent engineer six months from now look at this and ask
"why is it like this?"* If yes, write the ADR.

## Format

```markdown
# ADR-NNNN: Short title

- **Status:** proposed | accepted | superseded by ADR-NNNN
- **Date:** YYYY-MM-DD

## Context
What forced a decision. The constraints, not the solution.

## Decision
What was decided, in the active voice.

## Consequences
What this makes easy, what it makes hard, and what it rules out.
Include the costs — an ADR listing only benefits is marketing.

## Alternatives considered
What else was viable and why it lost. "None" is rarely true and always suspicious.
```

Number sequentially from `0001`. Never renumber or delete: superseding an ADR
means writing a new one and marking the old one superseded. The record of a
decision that turned out wrong is more valuable than its absence.

## Index

| ADR | Title | Status | Area |
|---|---|---|---|
| [0001](0001-nestjs-modular-monolith.md) | NestJS modular monolith | accepted | Architecture |
| [0002](0002-prisma-as-data-access-layer.md) | Prisma as the data access layer | accepted | Data |
| [0003](0003-hash-secrets-at-rest.md) | Hash secrets at rest, encrypt amounts | accepted | Security |
| [0004](0004-public-unauthenticated-verification.md) | Public unauthenticated verification | accepted | Security |
| [0005](0005-deterministic-credential-canonicalization.md) | Deterministic credential canonicalization | accepted | Domain |
| [0006](0006-outbox-anchoring.md) | Outbox pattern for contract anchoring | accepted | Integration |
| [0007](0007-keep-the-credentials-module.md) | Credentials module kept as a verification-only boundary | accepted | Architecture |

## Related

- [`../architecture.md`](../architecture.md) — modules, flows, invariants
- [`../versioning.md`](../versioning.md) — API versioning
- [`../disaster-recovery.md`](../disaster-recovery.md) — recovery procedures
