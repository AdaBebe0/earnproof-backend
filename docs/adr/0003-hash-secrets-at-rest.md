# ADR-0003: Hash secrets at rest, encrypt amounts

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The backend holds three kinds of sensitive value, and they need different
treatment:

1. **Bearer secrets** — session tokens and API keys. Only ever compared, never
   displayed.
2. **Lookup identifiers** — wallet addresses. Needed for indexing, not display.
3. **Financial values** — payment amounts. Must be read back to compute proofs.

Treating all three the same would either make amounts unreadable or leave
secrets recoverable.

## Decision

Match the mechanism to the access pattern:

- **Secrets are hashed.** `AuthSession.tokenHash` and `ApiKey.hash` store
  SHA-256 only. A raw token exists in one HTTP response and nowhere else.
  Comparison is timing-safe via
  [`timing-safe.ts`](../../src/common/crypto/timing-safe.ts).
- **Identifiers are hashed for indexing.** `User.walletHash` alongside the
  address.
- **Amounts are encrypted.** AES-256-GCM via
  [`protected-amount.ts`](../../src/common/crypto/protected-amount.ts), because
  proof issuance has to read them back.
- **Verification metadata is hashed with a salt version**, so salts can rotate
  without invalidating history.

## Consequences

**Easier.** A database dump does not yield usable session tokens or API keys.
Amount confidentiality survives at rest. Salt rotation is possible.

**Harder.** A lost token cannot be recovered, only reissued — correct, but it
surprises people. Encrypted amounts cannot be aggregated in SQL; anything that
sums them decrypts in application code first. `PAYMENT_ENCRYPTION_KEY` becomes
critical: losing it makes every stored amount unreadable, which
[`../disaster-recovery.md`](../disaster-recovery.md) has to account for.

**Ruled out.** Displaying an existing API key. The UI can show a prefix and
nothing more.

## Alternatives considered

**Encrypt everything, including tokens.** Rejected: reversibility is a liability
for a value that is only ever compared. Hashing removes the question of who can
decrypt.

**Store amounts in plaintext.** Rejected: they are the most directly sensitive
product data, and encryption at rest costs little given they are read one proof
at a time rather than aggregated.
