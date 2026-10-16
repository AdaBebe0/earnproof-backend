/**
 * SSRF protection for outbound webhook deliveries.
 *
 * This module is the webhook-facing entry point. All destination-validation
 * policy — scheme/port allowlisting, credential rejection, IP-range
 * blocking, DNS-revalidation-at-connect-time — is centralised in
 * `../common/http/destination-guard`; this file only re-exports it under the
 * names the webhook call sites already use, plus a webhook-flavoured error
 * type so existing `instanceof` checks keep working.
 *
 * See `../common/http/destination-guard.ts` for the full policy and its
 * rationale.
 */

import { lookup } from "node:dns/promises";
import {
  DestinationBlockedError,
  assertSafeDestination,
  assertSafeDestinationUrl,
} from "../common/http/destination-guard";

export class SsrfBlockedError extends DestinationBlockedError {
  constructor(reason: string) {
    super(reason);
    this.name = "SsrfBlockedError";
    // Keep the historical "SSRF" wording in the message — call sites and
    // stored failure reasons match against it — while `reason` (inherited)
    // still carries the plain, prefix-free explanation.
    this.message = `SSRF: blocked destination — ${reason}`;
  }
}

function rethrowAsSsrfError(err: unknown): never {
  if (err instanceof DestinationBlockedError) {
    throw new SsrfBlockedError(err.reason);
  }
  throw err;
}

/**
 * Throw `SsrfBlockedError` if `url` targets a forbidden destination on the
 * URL/scheme/credential/host level. Does not perform DNS resolution — call
 * `assertSafeWebhookDestination` for that immediately before delivering.
 */
export function assertSafeWebhookUrl(raw: string): void {
  try {
    assertSafeDestinationUrl(raw);
  } catch (err) {
    rethrowAsSsrfError(err);
  }
}

/**
 * Resolve a hostname immediately before delivery and reject it when any
 * returned address is non-public. Re-run this right before every delivery
 * attempt and retry — not just once at enqueue time — so a hostname's
 * resolved address is only ever trusted for the instant this function
 * checked it (defeats DNS-rebinding / TOCTOU).
 */
export async function assertSafeWebhookDestination(
  raw: string,
  resolve: typeof lookup = lookup,
): Promise<void> {
  try {
    await assertSafeDestination(raw, resolve);
  } catch (err) {
    rethrowAsSsrfError(err);
  }
}
