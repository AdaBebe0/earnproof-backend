import {
  HorizonFault,
  classifyStatus,
  classifyThrown,
  isRetryable,
  parseRetryAfterSeconds,
} from "./horizon-fault";

/**
 * The retry decision table, asserted directly.
 *
 * `horizon-client.spec.ts` proves the client acts on these classifications;
 * this file proves the classifications themselves are right. Keeping them apart
 * matters because the expensive mistakes here are silent: classifying a
 * malformed page as transient produces a sync that retries forever and never
 * says why, and classifying a 429 as permanent drops payments during ordinary
 * load.
 */

describe("status classification", () => {
  it.each([
    [429, "rate_limited", true],
    [500, "server_error", true],
    [502, "server_error", true],
    [503, "server_error", true],
    [504, "server_error", true],
    [400, "expired_cursor", false],
    [410, "expired_cursor", false],
    [404, "not_found", false],
    [401, "client_error", false],
    [403, "client_error", false],
    [422, "client_error", false],
  ])("maps HTTP %i to %s (retryable: %s)", (status, kind, retryable) => {
    expect(classifyStatus(status as number)).toBe(kind);
    expect(isRetryable(classifyStatus(status as number))).toBe(retryable);
  });

  it("treats an unknown 4xx as permanent rather than guessing", () => {
    // Retrying a request Horizon has already rejected as malformed burns the
    // budget and delays the real error.
    expect(isRetryable(classifyStatus(418))).toBe(false);
  });
});

describe("thrown-error classification", () => {
  it("maps a deadline to a retryable timeout", () => {
    const error = new Error("aborted");
    error.name = "TimeoutError";
    expect(classifyThrown(error)).toBe("timeout");
    expect(isRetryable("timeout")).toBe(true);
  });

  it("maps an abort to a timeout", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(classifyThrown(error)).toBe("timeout");
  });

  it("maps a connection failure to a retryable network error", () => {
    // This is the shape Node's fetch takes for DNS, TLS and reset failures.
    expect(classifyThrown(new TypeError("fetch failed"))).toBe("network_error");
    expect(isRetryable("network_error")).toBe(true);
  });

  it("preserves the kind of a fault that is already classified", () => {
    const fault = new HorizonFault("malformed_page", "unreadable");
    expect(classifyThrown(fault)).toBe("malformed_page");
  });

  it("falls back to a network error for an unrecognised throw", () => {
    expect(classifyThrown("something odd")).toBe("network_error");
    expect(classifyThrown(undefined)).toBe("network_error");
  });
});

describe("permanent kinds are never retried", () => {
  it.each(["expired_cursor", "not_found", "client_error", "malformed_page"] as const)(
    "%s",
    (kind) => {
      expect(isRetryable(kind)).toBe(false);
      expect(new HorizonFault(kind, "x").retryable).toBe(false);
    },
  );

  it("keeps expired_cursor out of the retryable set deliberately", () => {
    // It is recoverable, but not by repeating the request: the caller has to
    // drop the cursor and restart, which is a different decision.
    expect(isRetryable("expired_cursor")).toBe(false);
  });
});

describe("Retry-After parsing", () => {
  it.each([
    ["5", 5],
    ["0", 0],
    ["  12  ", 12],
    ["7.9", 7],
  ])("reads %s as %i seconds", (header, expected) => {
    expect(parseRetryAfterSeconds(header as string)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["soon"], ["-3"], ["Wed, 21 Oct 2015 07:28:00 GMT"]])(
    "ignores %s and lets the client use its own backoff",
    (header) => {
      expect(parseRetryAfterSeconds(header as string | null)).toBeUndefined();
    },
  );

  it("caps an implausibly long wait", () => {
    // Honouring an hour verbatim would hang the caller far past any request
    // deadline; the retry budget should run out normally instead.
    expect(parseRetryAfterSeconds("3600")).toBe(60);
    expect(parseRetryAfterSeconds("86400")).toBe(60);
  });
});

describe("fault messages", () => {
  it("never echoes the response body", () => {
    // A Horizon error payload carries the account that was queried, and this
    // message reaches logs.
    const fault = new HorizonFault("not_found", "Horizon has no record of this account", {
      status: 404,
    });

    expect(fault.message).not.toMatch(/G[A-Z0-9]{10,}/);
    expect(fault.status).toBe(404);
  });

  it("keeps the originating error as a cause for diagnosis", () => {
    const cause = new TypeError("fetch failed");
    const fault = new HorizonFault("network_error", "Horizon could not be reached", {
      cause,
    });

    expect(fault.cause).toBe(cause);
  });
});
