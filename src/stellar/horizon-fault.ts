/**
 * Fault taxonomy for Horizon reads.
 *
 * The whole point of naming these is retry policy. "The request failed" is not
 * actionable: retrying a rate limit is correct and retrying a malformed record
 * is an infinite loop that never makes progress. Every failure the client can
 * encounter is therefore classified into exactly one kind, and the kind — not
 * the status code, not the exception type — decides what happens next.
 *
 * The distinction that matters most is **transient vs permanent**. A transient
 * fault means "the same request may succeed later"; a permanent one means "this
 * request will never succeed, stop asking". Getting that wrong in either
 * direction is expensive: retrying a permanent fault burns the retry budget and
 * delays the real error, while giving up on a transient one drops payments that
 * would have arrived on the next attempt.
 */

export type HorizonFaultKind =
  /** HTTP 429. Transient, and Horizon usually tells us how long to wait. */
  | "rate_limited"
  /** HTTP 5xx. Transient: Horizon itself is unhealthy. */
  | "server_error"
  /** The request exceeded its deadline. Transient. */
  | "timeout"
  /** The request never completed — DNS, TLS, connection reset. Transient. */
  | "network_error"
  /**
   * The cursor was rejected. Permanent *for that cursor*: retrying with it
   * cannot work, but the sync can still make progress by restarting.
   */
  | "expired_cursor"
  /** The account does not exist. Permanent. */
  | "not_found"
  /** Any other 4xx. Permanent — our request was wrong. */
  | "client_error"
  /** The response was not a Horizon collection. Permanent for this page. */
  | "malformed_page";

/**
 * Kinds worth retrying.
 *
 * `expired_cursor` is deliberately absent. It is recoverable, but not by
 * repeating the request — the caller has to drop the cursor and start again,
 * which is a different decision from "wait and try once more".
 */
const RETRYABLE: ReadonlySet<HorizonFaultKind> = new Set<HorizonFaultKind>([
  "rate_limited",
  "server_error",
  "timeout",
  "network_error",
]);

export function isRetryable(kind: HorizonFaultKind): boolean {
  return RETRYABLE.has(kind);
}

/** A classified Horizon failure. */
export class HorizonFault extends Error {
  readonly kind: HorizonFaultKind;
  readonly status?: number;
  /** Seconds Horizon asked us to wait, when it said so. */
  readonly retryAfterSeconds?: number;

  constructor(
    kind: HorizonFaultKind,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    // The message is a fixed description of the kind, never an echo of the
    // response body: a Horizon error payload can carry the account address that
    // was queried, and this message reaches logs.
    //
    // The originating error is kept as `cause` instead. It is not logged, but
    // it is what makes a failure diagnosable: without it, every transport-level
    // problem collapses into the same four words and a stack that stops at the
    // retry loop.
    super(message, { cause: options.cause });
    this.name = "HorizonFault";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

/**
 * Parses a `Retry-After` header.
 *
 * Only the delta-seconds form is honoured. The HTTP-date form is legal but
 * Horizon does not send it, and accepting it would mean trusting a server clock
 * against ours to compute a delay — a skew of an hour would stall a sync for an
 * hour. An unparseable value yields `undefined`, and the caller falls back to
 * its own backoff.
 */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  // A server asking us to wait an hour is more likely misconfigured than
  // serious, and honouring it would hang the caller well past any request
  // deadline. Cap it and let the retry budget run out normally.
  return Math.min(Math.floor(seconds), 60);
}

/** Classifies an HTTP status into a fault kind. */
export function classifyStatus(status: number): HorizonFaultKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status === 404) return "not_found";
  // Horizon answers 400 for a cursor it cannot decode or has aged out.
  if (status === 400 || status === 410) return "expired_cursor";
  return "client_error";
}

/**
 * Classifies a thrown transport error.
 *
 * `AbortError` is the shape both an explicit cancellation and a deadline take,
 * so the caller distinguishes them by checking its own cancellation signal
 * first — see `HorizonClient`. Everything else that escapes `fetch` is a
 * connection-level problem and therefore transient.
 */
export function classifyThrown(error: unknown): HorizonFaultKind {
  if (error instanceof HorizonFault) return error.kind;

  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";

  return "network_error";
}
