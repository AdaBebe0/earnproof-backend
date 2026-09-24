# ADR-0001: NestJS modular monolith

- **Status:** accepted
- **Date:** 2026-08-26

## Context

EarnProof spans authentication, payment synchronization, proof issuance,
credential signing, on-chain anchoring, and webhook delivery. These have
different load profiles: verification is read-heavy and public, anchoring is a
slow background queue, payment sync is bursty.

A service-per-domain split would let each scale independently. It would also
mean network calls, distributed transactions, and independent deployments — for
a team that has not yet established the boundaries those services would follow.

## Decision

A single NestJS application with strict module boundaries, wired in
[`src/app.module.ts`](../../src/app.module.ts). Each module owns its tables and
declares which modules it must not depend on, recorded in
[`../architecture.md`](../architecture.md).

## Consequences

**Easier.** Transactions stay local — proof, claim, and anchoring intent commit
together in one database call rather than a saga. Refactoring across module
boundaries is a compile error, not a production incident. One deployment.

**Harder.** Everything scales together: a slow anchoring job and a fast
verification read share a process. Nothing structural prevents a module from
importing another's internals, so the boundaries are enforced by review and by
the documented forbidden-dependency lists.

**Ruled out.** Independent per-module scaling and deployment, without first
extracting a service.

The boundaries are documented specifically so extraction stays possible. A
module that already declares its tables and its forbidden dependencies is one
that can be lifted out when there is a reason to.

## Alternatives considered

**Microservices from the start.** Rejected: the boundaries were not yet known.
Splitting on guesses produces services that need constant cross-calls, which is
worse than a monolith with clear internal modules.

**Unstructured Express application.** Rejected: no dependency injection story,
and module boundaries would exist only in folder names.
