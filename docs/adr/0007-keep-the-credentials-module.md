# ADR-0007: Keep the credentials module as a verification-only boundary

- **Status:** accepted
- **Date:** 2026-08-30

## Context

`CredentialsController` was raised as possible dead code: a controller with no
service behind it, and therefore either an unfinished feature or a leftover to
delete. The question was posed as a choice — implement `CredentialsService`, or
remove the controller.

The module is not dead. `CredentialsService` exists and is the verification path
the product depends on: it bounds the submitted payload, validates the credential
shape, recomputes the canonical hash and HMAC signature, compares both in
constant time, and reconciles the result against the stored proof — revocation,
expiry, issuer state, and the on-chain commitment where anchoring is enabled. It
is covered by unit tests in `credentials.service.spec.ts`.

What was genuinely missing was smaller and less visible: nothing tested the
controller itself, and nothing recorded *why* this module exists separately from
`proofs`, which is the question that made it look like dead code in the first
place. A reader who cannot tell a deliberate boundary from an accident will
eventually delete it.

The boundary matters because the two modules sit on opposite sides of a trust
line. `proofs` issues credentials and requires an authenticated wallet.
`credentials` accepts a document from a stranger — a landlord, a lender, an
employer — and must answer without disclosing anything about the worker beyond a
single verdict. Merging them would put an unauthenticated, adversarial input path
into the module that holds the signing key and the issuance logic.

## Decision

Keep the module, and keep it verification-only.

`credentials` owns exactly one operation: `POST /credentials/verify`. It reads
proofs; it never writes them, never issues a credential, and never returns
anything but a verdict. Issuance, listing, revocation and any future export
format stay in `proofs`, which already owns the signing key and the
authenticated surface those operations require.

The module is completed rather than removed: `credentials.controller.spec.ts`
now covers the controller's own responsibilities — unwrapping the request
envelope, returning each verdict unchanged, letting a rejection reach the error
filter instead of becoming a verdict, and enforcing the size, depth, type and
unknown-field limits through the same `ValidationPipe` configuration the
application runs.

## Consequences

The verification path can be reasoned about on its own. It is the one
unauthenticated route that parses a caller-supplied document, so keeping it in a
module of its own means the review question "what can a stranger submit?" has a
one-directory answer.

Returning a verdict rather than a status code costs callers a branch: a forged,
revoked or expired credential answers `200`, and a client that branches on HTTP
status alone will treat all three as success. The endpoint's documentation states
this explicitly, and the service's result union enumerates every outcome.

The cost is a boundary that must be maintained. `credentials` reads the `Proof`
table that `proofs` owns, which is a documented exception rather than a pattern
to copy; a second reader of that table should be a conversation, not a commit.
Anything that needs to *write* proof state belongs in `proofs`, and putting it
here would be a regression this ADR exists to catch.

Export formats — a credential rendered as a PDF, a QR payload, a wallet-importable
document — are ruled out of this module. They are issuance concerns: they need
the credential's full contents and the authenticated owner, both of which live in
`proofs`.

## Alternatives considered

**Remove the controller and fold verification into `proofs`.** Fewer modules, one
fewer boundary to police. Rejected: it would place an unauthenticated endpoint
that parses attacker-supplied documents inside the module holding the signing
key, and it would make the "what is reachable without a credential?" review
question require reading the whole proofs surface.

**Merge `credentials` into `proofs` but keep the route path.** Same trust
problem, hidden behind a URL that suggests a separation the code no longer has.
Worse than either honest option.

**Grow the module into a general credential store — lookup by id, export
formats, re-issuance.** Rejected for now: every one of those needs authentication
and the credential's full contents, which is the definition of the `proofs`
surface. Building them here would duplicate authorization logic across two
modules, and duplicated authorization is where authorization bugs live. If the
product needs them, they belong behind `proofs` and this ADR should be superseded
rather than quietly widened.

**Leave it as it was.** The code worked; only the record and the controller tests
were missing. Rejected because "it works, ask the author" is not a decision
anyone can inherit, and the module had already been read once as dead code.
