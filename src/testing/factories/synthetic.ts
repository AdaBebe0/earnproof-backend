import { createHash } from "node:crypto";

/**
 * Deterministic, unmistakably-synthetic value generation.
 *
 * Two properties matter and they pull in opposite directions.
 *
 * Determinism: the same seed must always produce the same value, or tests that
 * depend on generated data become order-dependent and flaky. Nothing here reads
 * the clock or a random source.
 *
 * Recognisability: every generated value must be obviously fake ON SIGHT. This
 * is the privacy control. Fixtures get pasted into issues, screenshots, and
 * support tickets; a realistic-looking wallet address or transaction hash in
 * that context is indistinguishable from a leak of real customer data, and
 * nobody can tell by looking whether it needs to be treated as an incident.
 *
 * The two are reconciled by deriving values from a hash (deterministic) and then
 * prefixing them with a loud marker (recognisable).
 */

/**
 * Marker embedded in every generated identifier.
 *
 * Grep-able on purpose: `SYNTHETIC` appearing in a production database or log is
 * an immediate, unambiguous signal that test data reached somewhere it should
 * not have.
 */
export const SYNTHETIC_MARKER = "SYNTHETIC";

/**
 * Derive a stable hex digest from a namespace and seed.
 *
 * SHA-256 is used purely as a deterministic spreading function — there is no
 * security property being claimed. It replaces a seeded PRNG so that callers can
 * generate any field independently, in any order, without threading generator
 * state through every builder.
 */
function digest(namespace: string, seed: string | number): string {
  return createHash("sha256")
    .update(`${SYNTHETIC_MARKER}:${namespace}:${String(seed)}`)
    .digest("hex");
}

/** Deterministic integer in [min, max]. */
export function syntheticInt(
  namespace: string,
  seed: string | number,
  min: number,
  max: number,
): number {
  if (max < min) {
    throw new Error(`syntheticInt: max (${max}) is below min (${min})`);
  }
  const span = max - min + 1;
  const value = parseInt(digest(namespace, seed).slice(0, 8), 16);
  return min + (value % span);
}

/**
 * A synthetic Stellar-shaped address.
 *
 * Deliberately NOT a valid Stellar address: real addresses are base32 with a
 * CRC checksum, and these will fail validation on any real network. That is the
 * safety property — a synthetic address can never accidentally address a real
 * account or become a live destination for funds.
 */
export function syntheticWalletAddress(seed: string | number): string {
  const body = digest("wallet", seed).toUpperCase().slice(0, 39);
  return `GSYNTHETIC${body}`.slice(0, 56).padEnd(56, "X");
}

/** A synthetic wallet hash, matching how the app stores hashed addresses. */
export function syntheticWalletHash(seed: string | number): string {
  return `sha256:synthetic-${digest("wallet-hash", seed).slice(0, 32)}`;
}

/**
 * A synthetic transaction hash.
 *
 * Real Stellar transaction hashes are 64 hex characters. This embeds a literal
 * "synthetic" prefix so it cannot be mistaken for one, and cannot be pasted into
 * a block explorer and silently resolve to a real transaction.
 */
export function syntheticTransactionHash(seed: string | number): string {
  return `synthetic${digest("tx", seed).slice(0, 55)}`;
}

/** A synthetic credential hash in the app's `sha256:` form. */
export function syntheticCredentialHash(seed: string | number): string {
  return `sha256:synthetic${digest("credential", seed).slice(0, 55)}`;
}

/**
 * A synthetic secret.
 *
 * Prefixed so that a leaked-credential scanner, or a human reviewing a diff,
 * classifies it instantly. Never derived from, or shaped like, a real key.
 */
export function syntheticSecret(seed: string | number): string {
  return `synthetic-not-a-real-secret-${digest("secret", seed).slice(0, 24)}`;
}

/**
 * A synthetic URL on a reserved-for-documentation domain.
 *
 * `example.invalid` is guaranteed by RFC 2606 never to resolve, so a fixture
 * webhook can never deliver to a host somebody actually controls — which is what
 * makes an accidentally-seeded webhook harmless rather than an SSRF vector.
 */
export function syntheticUrl(path: string, seed: string | number): string {
  const suffix = digest("url", seed).slice(0, 8);
  return `https://synthetic-${suffix}.example.invalid/${path.replace(/^\//, "")}`;
}

/**
 * A synthetic monetary amount as a decimal string.
 *
 * Returned as a string rather than a number because amounts are money: binary
 * floating point cannot represent most decimal amounts exactly, and a factory
 * that introduced rounding error would make tests assert on wrong values.
 */
export function syntheticAmount(
  seed: string | number,
  options: { min?: number; max?: number } = {},
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 5_000;
  const whole = syntheticInt("amount-whole", seed, min, max);
  const cents = syntheticInt("amount-cents", seed, 0, 99);
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

/** A synthetic organization slug. */
export function syntheticSlug(seed: string | number): string {
  return `synthetic-org-${digest("slug", seed).slice(0, 8)}`;
}

/**
 * A deterministic timestamp offset from a fixed epoch.
 *
 * Anchored to a constant rather than `Date.now()` so that a fixture generated
 * today and one generated next month are byte-identical. A factory that used the
 * current time would make snapshot comparisons drift daily.
 */
export const SYNTHETIC_EPOCH = new Date("2025-01-01T00:00:00.000Z");

export function syntheticDate(offsetDays: number): Date {
  return new Date(SYNTHETIC_EPOCH.getTime() + offsetDays * 86_400_000);
}

/**
 * Assert a value carries a synthetic marker.
 *
 * Used by the factory tests to prove no builder silently emits a realistic
 * value, which is the failure this whole module is designed to prevent.
 */
export function isSynthetic(value: string): boolean {
  return /synthetic/i.test(value);
}
