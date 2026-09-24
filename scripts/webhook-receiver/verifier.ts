/**
 * Reference verifier for EarnProof signed webhooks.
 *
 * This is the implementation integrators are meant to read and port. It is
 * deliberately dependency-free — `node:crypto` only — so it can be translated
 * line by line into another language, and it is the exact code the conformance
 * vectors are run against, so the documentation cannot drift from something
 * that has never been executed.
 *
 * ## The scheme
 *
 * Signing base (the three parts joined with a literal `.`):
 *
 *     <unix-timestamp-seconds>.<deliveryId>.<raw-request-body>
 *
 * Signature header value: `v1=` followed by the lowercase hex HMAC-SHA256 of
 * that base string, keyed with the raw UTF-8 bytes of the endpoint's secret.
 *
 * ## What this file will not do
 *
 * It never parses the body. Verification is over the exact bytes that arrived;
 * a receiver that verifies a re-serialised object is checking a value the
 * sender never signed, and the `tampered-body-reordered-keys` vector exists to
 * fail that implementation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Header names, lowercased — Node lowercases inbound header keys. */
export const HEADERS = {
  timestamp: "x-earnproof-timestamp",
  delivery: "x-earnproof-delivery",
  event: "x-earnproof-event",
  signature: "x-earnproof-signature",
} as const;

/** Default replay window. A delivery older or newer than this is refused. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The only signature shape this version accepts.
 *
 * Anchored, lowercase, and exactly 64 hex characters. Being strict here is what
 * makes the constant-time comparison below safe to reach: by the time we
 * compare, both operands are known to be 32 bytes, so the comparison cannot
 * fall back to a length check that leaks.
 */
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

/** Whole, non-negative seconds. Rejects fractions, milliseconds and signs. */
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export type VerificationFailureReason =
  | "missing_signature"
  | "missing_timestamp"
  | "missing_delivery_id"
  | "malformed_signature"
  | "malformed_timestamp"
  | "timestamp_outside_tolerance"
  | "signature_mismatch";

export interface VerifyWebhookInput {
  /**
   * Every secret currently accepted for this endpoint.
   *
   * More than one only during a rotation window. All of them are tried, and
   * every one is tried on every call — see the loop below for why.
   */
  secrets: readonly string[];
  /** The exact bytes of the request body. Not a string, not a parsed object. */
  rawBody: Buffer;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  deliveryIdHeader: string | null | undefined;
  /** Current time in whole seconds. Injected so tests are not clock-dependent. */
  nowSeconds: number;
  toleranceSeconds?: number;
}

export type VerifyWebhookResult =
  | { ok: true; deliveryId: string; timestamp: number }
  | { ok: false; reason: VerificationFailureReason };

/**
 * Verifies one inbound delivery.
 *
 * Returns a reason rather than throwing, because the caller needs to map the
 * outcome onto a status code and a decision about retrying, and an exception
 * type is a clumsy way to carry that.
 *
 * This function is stateless. Delivery-ID deduplication is a separate concern
 * ({@link DeliveryIdStore}) and must run *after* this returns `ok` — see the
 * warning on that class.
 */
export function verifyWebhookSignature(
  input: VerifyWebhookInput,
): VerifyWebhookResult {
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const signatureHeader = nonEmpty(input.signatureHeader);
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };

  const timestampHeader = nonEmpty(input.timestampHeader);
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };

  const deliveryId = nonEmpty(input.deliveryIdHeader);
  if (!deliveryId) return { ok: false, reason: "missing_delivery_id" };

  const signatureMatch = SIGNATURE_PATTERN.exec(signatureHeader);
  if (!signatureMatch) return { ok: false, reason: "malformed_signature" };

  if (!TIMESTAMP_PATTERN.test(timestampHeader)) {
    return { ok: false, reason: "malformed_timestamp" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "malformed_timestamp" };
  }

  // Checked before the HMAC: a delivery outside the window is refused whether
  // or not it is authentic, so there is nothing to learn by hashing first.
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }

  const provided = Buffer.from(signatureMatch[1], "hex");
  const base = signingBase(timestamp, deliveryId, input.rawBody);

  // Every secret is tried on every call, and the result is accumulated rather
  // than returned early. Short-circuiting on the first match would make the
  // response time reveal which secret matched, which during a rotation window
  // tells an observer whether the endpoint has cut over yet.
  let matched = false;
  for (const secret of input.secrets) {
    const candidate = createHmac("sha256", secret).update(base).digest();
    const equal =
      candidate.length === provided.length && timingSafeEqual(candidate, provided);
    matched = matched || equal;
  }

  if (!matched) return { ok: false, reason: "signature_mismatch" };

  return { ok: true, deliveryId, timestamp };
}

/**
 * Builds the signed byte sequence.
 *
 * Assembled as a Buffer rather than by string concatenation so the body's bytes
 * are never round-tripped through a string decoder. A body that is not valid
 * UTF-8 would otherwise pick up replacement characters and fail to verify
 * against a signature the sender computed over the original bytes.
 */
export function signingBase(
  timestamp: number,
  deliveryId: string,
  rawBody: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${timestamp}.${deliveryId}.`, "utf8"),
    rawBody,
  ]);
}

/**
 * Computes the signature header value for a delivery.
 *
 * Present so the conformance kit can generate a request the way the sender
 * does. A receiver never needs it.
 */
export function computeSignatureHeader(
  secret: string,
  timestamp: number,
  deliveryId: string,
  rawBody: Buffer,
): string {
  const digest = createHmac("sha256", secret)
    .update(signingBase(timestamp, deliveryId, rawBody))
    .digest("hex");
  return `v1=${digest}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Bounded store of delivery IDs already processed.
 *
 * **Only record an ID after the signature has verified.** Recording on arrival
 * lets anyone who can reach the endpoint send an unsigned request carrying a
 * guessed or observed delivery ID and have the genuine delivery silently
 * discarded as a duplicate. The `dedup-cache-poisoning` scenario in the
 * conformance vectors exists to catch exactly that ordering mistake.
 *
 * Bounded on purpose. An unbounded map is a memory-exhaustion target, and the
 * TTL is what lets a legitimate replay — requested deliberately, long after the
 * fact — be processed again rather than dropped forever.
 */
export class DeliveryIdStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlSeconds: number;
  private readonly maxEntries: number;

  constructor(options: { ttlSeconds?: number; maxEntries?: number } = {}) {
    this.ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
    this.maxEntries = options.maxEntries ?? 100_000;
  }

  /**
   * Records a delivery ID.
   *
   * @returns `true` if this is the first time the ID has been seen inside the
   * TTL, `false` if it is a duplicate that must not be processed again.
   */
  register(deliveryId: string, nowSeconds: number): boolean {
    this.evictExpired(nowSeconds);

    const previous = this.seen.get(deliveryId);
    if (previous !== undefined && nowSeconds - previous <= this.ttlSeconds) {
      return false;
    }

    this.seen.set(deliveryId, nowSeconds);

    // Map preserves insertion order, so the oldest key is the first key.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }

    return true;
  }

  /** Number of retained IDs. Exposed for tests asserting the bound holds. */
  get size(): number {
    return this.seen.size;
  }

  private evictExpired(nowSeconds: number): void {
    for (const [id, at] of this.seen) {
      if (nowSeconds - at > this.ttlSeconds) {
        this.seen.delete(id);
        continue;
      }
      // Insertion-ordered and monotonic, so the first live entry ends the sweep.
      break;
    }
  }
}
