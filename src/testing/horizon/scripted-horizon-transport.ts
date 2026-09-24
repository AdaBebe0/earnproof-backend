import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  HorizonHttpResponse,
  HorizonRequest,
  HorizonTransport,
} from "../../stellar/horizon-transport";

/**
 * A deterministic Horizon transport driven by frozen fixtures.
 *
 * Every fault this suite exercises — a 429, a timeout, a reorganised page, a
 * cursor Horizon has forgotten — is impossible to provoke reliably against a
 * real Horizon and trivial to script here. That is the entire justification for
 * the transport seam: the client's decisions are the thing under test, and they
 * can only be tested if the inputs are chosen rather than observed.
 *
 * The stub is strict on purpose. It answers requests in scripted order, asserts
 * the cursor each request carried when the fixture says what it should be, and
 * refuses a request it has no script for. A permissive stub that returned an
 * empty page for anything unexpected would let a client that paginates wrongly
 * pass, which is the one thing this suite exists to prevent.
 *
 * Nothing here reads the clock, a random source, or the network.
 */

const FIXTURE_RELATIVE_PATH = join(
  "test",
  "fixtures",
  "horizon",
  "horizon-scenarios.json",
);

/** Fixture version this loader understands. */
export const SUPPORTED_FIXTURE_VERSION = 1;

export interface ScriptedStep {
  /**
   * The cursor the client is expected to send on this request.
   *
   * `null` means "no cursor" (the first page). Absent means the fixture does
   * not constrain it.
   */
  expectCursor?: string | null;
  response?: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  };
  /** Simulates a transport-level failure instead of a response. */
  throw?: "timeout" | "network" | "abort";
}

export interface ScriptedScenario {
  description: string;
  steps: ScriptedStep[];
}

export interface HorizonFixtureFile {
  fixtureVersion: number;
  horizonUrl: string;
  account: string;
  counterparty: string;
  assetIssuer: string;
  epoch: string;
  scenarios: Record<string, ScriptedScenario>;
}

/**
 * Locates the fixture file by walking up from this module.
 *
 * Not a fixed relative hop: this module is loaded from source under ts-jest and
 * from `dist/` after a build, and those sit at different depths.
 */
function resolveFixturePath(): string {
  let directory = __dirname;

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, FIXTURE_RELATIVE_PATH);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = resolve(directory, "..");
      if (parent === directory) break;
      directory = parent;
    }
  }

  throw new Error(
    `Could not locate ${FIXTURE_RELATIVE_PATH} above ${__dirname}.`,
  );
}

let cached: HorizonFixtureFile | undefined;

export function loadHorizonFixtures(): HorizonFixtureFile {
  if (cached) return cached;

  const parsed = JSON.parse(
    readFileSync(resolveFixturePath(), "utf8"),
  ) as HorizonFixtureFile;

  if (parsed.fixtureVersion !== SUPPORTED_FIXTURE_VERSION) {
    // A version bump means the shape changed. Failing loudly here beats every
    // scenario failing for an unrelated-looking reason.
    throw new Error(
      `Horizon fixture version ${parsed.fixtureVersion} is not supported ` +
        `(expected ${SUPPORTED_FIXTURE_VERSION}). See docs/testing-horizon.md.`,
    );
  }

  cached = parsed;
  return parsed;
}

export function scenario(id: string): ScriptedScenario {
  const fixtures = loadHorizonFixtures();
  const found = fixtures.scenarios[id];
  if (!found) {
    throw new Error(
      `Unknown Horizon scenario "${id}". Available: ${Object.keys(fixtures.scenarios).sort().join(", ")}`,
    );
  }
  return found;
}

/** One request the stub served, for assertions about pagination. */
export interface RecordedRequest {
  url: string;
  cursor: string | null;
  limit: string | null;
  order: string | null;
}

export class ScriptExhaustedError extends Error {
  constructor(requestCount: number, scenarioId: string) {
    super(
      `Scenario "${scenarioId}" scripted ${requestCount} response(s) but the client asked for more. ` +
        `Either the client is paginating further than expected, or the fixture is short a step.`,
    );
    this.name = "ScriptExhaustedError";
  }
}

export class UnexpectedCursorError extends Error {
  constructor(step: number, expected: string | null, actual: string | null) {
    super(
      `Request ${step + 1} carried cursor ${describe(actual)} but the fixture expects ${describe(expected)}. ` +
        `The client is not following Horizon's next link correctly.`,
    );
    this.name = "UnexpectedCursorError";
  }
}

function describe(cursor: string | null): string {
  return cursor === null ? "none" : `"${cursor}"`;
}

export interface ScriptedTransportOptions {
  /**
   * Aborts the caller's signal once this many requests have been served.
   *
   * Cancellation has to be triggered from inside the read to be meaningful —
   * aborting before the call starts only tests the entry guard. Driving it from
   * the transport makes "cancelled mid-walk" deterministic, with no timers.
   */
  abortAfterRequests?: number;
  abortController?: AbortController;
}

/**
 * Serves a scripted scenario, in order, once per request.
 */
export class ScriptedHorizonTransport implements HorizonTransport {
  readonly requests: RecordedRequest[] = [];

  private index = 0;

  constructor(
    private readonly scenarioId: string,
    private readonly script: ScriptedScenario = scenario(scenarioId),
    private readonly options: ScriptedTransportOptions = {},
  ) {}

  /** Requests served so far. */
  get requestCount(): number {
    return this.requests.length;
  }

  /** Steps scripted but never reached — a walk that stopped earlier than planned. */
  get unusedSteps(): number {
    return this.script.steps.length - this.index;
  }

  async get(request: HorizonRequest): Promise<HorizonHttpResponse> {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    this.requests.push({
      url: request.url,
      cursor,
      limit: url.searchParams.get("limit"),
      order: url.searchParams.get("order"),
    });

    const step = this.script.steps[this.index];
    if (!step) {
      throw new ScriptExhaustedError(this.script.steps.length, this.scenarioId);
    }

    // The cursor is checked before the step is consumed. The client retries
    // transport errors, so consuming first would make attempt two fail with
    // "script exhausted" and bury the mismatch that actually caused it.
    if (step.expectCursor !== undefined && step.expectCursor !== cursor) {
      throw new UnexpectedCursorError(this.index, step.expectCursor, cursor);
    }

    this.index += 1;

    // Abort *after* recording the request, so the test can assert how far the
    // walk got before cancellation took effect.
    if (
      this.options.abortAfterRequests !== undefined &&
      this.requests.length >= this.options.abortAfterRequests
    ) {
      this.options.abortController?.abort();
    }

    if (step.throw) {
      throw transportError(step.throw);
    }

    const response = step.response;
    if (!response) {
      throw new Error(
        `Scenario "${this.scenarioId}" step ${this.index} has neither a response nor a throw.`,
      );
    }

    return {
      status: response.status,
      body: response.body,
      headers: response.headers ?? {},
    };
  }
}

/**
 * Builds the error shape each transport-level failure actually takes.
 *
 * The names matter: the client classifies by `error.name`, so a stub that threw
 * a generic `Error` for a timeout would exercise the network-error path instead
 * and quietly prove the wrong thing.
 */
function transportError(kind: "timeout" | "network" | "abort"): Error {
  if (kind === "timeout") {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
  }

  if (kind === "abort") {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  }

  const error = new TypeError("fetch failed");
  return error;
}

/**
 * A sleep that records what it was asked to wait without waiting.
 *
 * Backoff is a decision, not a duration, as far as these tests are concerned.
 * Asserting on the recorded delays proves the retry policy — including that a
 * `Retry-After` header was honoured — while keeping the suite instant and
 * immune to timing flakiness.
 */
export class RecordingSleep {
  readonly delays: number[] = [];

  readonly sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    this.delays.push(ms);
    if (signal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
  };
}
