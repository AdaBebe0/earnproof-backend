import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Webhook signing and verification.
 *
 * ## Signing scheme
 *
 * Algorithm: HMAC-SHA256
 *
 * Signing base string (all three parts joined with a literal `.`):
 *   `<unix-timestamp-seconds>.<deliveryId>.<raw-request-body>`
 *
 * Example:
 *   `1724400000.clxyz123.{"specVersion":"1","id":"clxyz123",...}`
 *
 * ## Request headers sent on every delivery
 *
 * | Header                    | Value                                      |
 * |---------------------------|--------------------------------------------|
 * | `X-EarnProof-Timestamp`   | Unix timestamp in seconds (string)         |
 * | `X-EarnProof-Delivery`    | Delivery ID (cuid)                         |
 * | `X-EarnProof-Event`       | Event type, e.g. `proof.created`           |
 * | `X-EarnProof-Signature`   | `v1=<hex-encoded-HMAC-SHA256-digest>`      |
 * | `Content-Type`            | `application/json`                         |
 *
 * ## Integrator verification procedure
 *
 * 1. Read `X-EarnProof-Timestamp` and `X-EarnProof-Delivery` from headers.
 * 2. Construct the signing base string:
 *    `timestamp + "." + deliveryId + "." + rawRequestBody`
 * 3. Compute `HMAC-SHA256(signingSecret, baseString)` and hex-encode.
 * 4. Prepend `v1=` and compare with `X-EarnProof-Signature` using a
 *    constant-time comparison.
 * 5. Optionally reject requests where the timestamp is more than 5 minutes
 *    old to prevent replay attacks.
 */
@Injectable()
export class WebhookSigningService {
  /**
   * Compute the signature header value for an outbound delivery.
   *
   * @param secret      Raw (decrypted) signing secret for the endpoint.
   * @param timestamp   Unix timestamp in seconds.
   * @param deliveryId  Delivery ID (cuid).
   * @param body        Serialised JSON request body.
   */
  sign(
    secret: string,
    timestamp: number,
    deliveryId: string,
    body: string,
  ): string {
    const baseString = `${timestamp}.${deliveryId}.${body}`;
    const digest = createHmac("sha256", secret)
      .update(baseString, "utf8")
      .digest("hex");
    return `v1=${digest}`;
  }

  /**
   * Verify an inbound signature (used in tests and by integrators).
   *
   * Returns `true` only when the computed digest matches the supplied
   * signature in constant time.
   */
  verify(
    secret: string,
    timestamp: number,
    deliveryId: string,
    body: string,
    signature: string,
  ): boolean {
    const expected = this.sign(secret, timestamp, deliveryId, body);
    try {
      return timingSafeEqual(
        Buffer.from(expected, "utf8"),
        Buffer.from(signature, "utf8"),
      );
    } catch {
      // Buffers differ in length — definitely not equal.
      return false;
    }
  }
}
