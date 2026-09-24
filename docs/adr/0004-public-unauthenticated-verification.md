# ADR-0004: Public unauthenticated verification

- **Status:** accepted
- **Date:** 2026-08-26

## Context

A proof is presented by a worker to a relying party — a landlord, a lender, a
platform. That party needs to check it is genuine, unexpired, and unrevoked.

Requiring them to hold an account would make verification useless in exactly the
situation the product exists for. But an open endpoint keyed on a proof id is
also an enumeration surface.

## Decision

`GET /proofs/:id/verify` requires no authentication.

Its response is deliberately narrow: validity, status, expiry, and revocation.
No wallet address, no payment history, no amounts, no issuer detail beyond what
is needed to establish trust. Every call is recorded as a
`VerificationEventLog` with **hashed** metadata
([`verification-event.service.ts`](../../src/audit/verification-event.service.ts)),
so abuse is detectable without building a log of who checked whom.

## Consequences

**Easier.** A relying party verifies a credential with a URL. That is the
product working as intended.

**Harder.** Proof ids are guessable in principle, so the endpoint is an
enumeration target — mitigated by the throttler and by the response carrying
nothing worth enumerating for. It is also the endpoint most likely to be
widened by accident: **anything added to this response becomes public to anyone
holding a proof id.**

**Ruled out.** Putting subject-identifying data in the verification response,
now or later.

## Alternatives considered

**Require an account.** Rejected: it defeats the purpose. A worker cannot ask
every landlord to sign up.

**Signed, expiring verification links.** Viable and stronger, and it would let
the subject control who verifies. Rejected for now as added integration burden
on relying parties. Worth revisiting if enumeration becomes a real problem
rather than a theoretical one.
