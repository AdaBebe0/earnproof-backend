# ADR-0005: Deterministic credential canonicalization

- **Status:** accepted
- **Date:** 2026-08-26

## Context

A credential is signed at issuance and verified later — possibly much later, by
a different process, after the code has changed.

Verification recomputes the signature over the claim. That only works if the
claim serializes to identical bytes both times. JavaScript object key order,
number formatting, and optional-field handling all vary in ways that are
invisible until a signature fails.

## Decision

All credential payloads pass through
[`canonicalize.ts`](../../src/common/crypto/canonicalize.ts) before hashing and
signing: keys sorted, formatting fixed, representation stable.

**The canonical form is frozen.** Any change to it invalidates every credential
ever issued, because their signatures were computed over the old form.

## Consequences

**Easier.** A credential signed today verifies indefinitely. Verification needs
no version negotiation.

**Harder.** `canonicalize.ts` cannot be refactored casually — a "harmless"
cleanup that reorders output silently breaks every existing credential, and the
failure appears at verification time, in production, for credentials issued
before the change. This is recorded in
[`../architecture.md`](../architecture.md) as invariant I14 and enforced by
[`credentials.service.spec.ts`](../../src/credentials/credentials.service.spec.ts).

**Ruled out.** Changing the canonical form without a migration plan for
already-issued credentials. There is currently no such mechanism, so in practice
this rules out changing it at all.

## Alternatives considered

**Sign the raw JSON string as produced.** Rejected: it makes the signature
depend on incidental serialization order, so the same claim can produce
different signatures.

**Version the canonical form and store the version per credential.** The correct
long-term answer, and what a change would require. Not built yet because there
is one form and no reason to change it; the cost is that introducing a second
form is now a project rather than an edit.
