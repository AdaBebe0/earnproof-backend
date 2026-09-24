import { HorizonFault, parseRetryAfterSeconds } from "./horizon-fault";

/**
 * The seam between the Horizon client and the network.
 *
 * Everything above this interface is deterministic: given the same sequence of
 * responses, the client takes the same decisions every time. That is what makes
 * the fault scenarios testable at all — a test that has to provoke a real 429
 * from a real Horizon is not a test, it is a wish.
 *
 * The interface is deliberately narrow. It carries no notion of retries,
 * cursors, or Horizon semantics; it performs one HTTP GET and reports what came
 * back. All policy lives in the client, so the stub used in tests cannot
 * accidentally implement half of it.
 */

export interface HorizonHttpResponse {
  status: number;
  /** Parsed JSON body, or `undefined` when the body was absent or unparseable. */
  body: unknown;
  /** Response headers, lowercased. Only `retry-after` is read today. */
  headers: Readonly<Record<string, string>>;
}

export interface HorizonRequest {
  url: string;
  /** Cancels the request. Carries both caller cancellation and the deadline. */
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface HorizonTransport {
  get(request: HorizonRequest): Promise<HorizonHttpResponse>;
}

/**
 * The production transport: one `fetch`, with a deadline.
 *
 * Node's `fetch` has no timeout of its own — a connection that opens and then
 * goes quiet hangs until the process exits. The deadline is therefore imposed
 * here with an `AbortSignal`, combined with the caller's cancellation signal so
 * either can end the request.
 */
export class FetchHorizonTransport implements HorizonTransport {
  async get(request: HorizonRequest): Promise<HorizonHttpResponse> {
    const deadline = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal
      ? anySignal([request.signal, deadline])
      : deadline;

    const response = await fetch(request.url, { signal });

    return {
      status: response.status,
      body: await readJson(response),
      headers: readHeaders(response),
    };
  }
}

/**
 * Reads a JSON body without letting a bad one throw.
 *
 * A body that is not JSON is a fact about the response, not an exception: the
 * client turns it into a `malformed_page` fault with the status attached, which
 * is far more diagnosable than a bare `SyntaxError` from deep inside `fetch`.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};

  // Only headers the client acts on are copied. Copying everything would put
  // whatever Horizon chose to send into objects that get logged on failure.
  const retryAfter = response.headers?.get?.("retry-after");
  if (retryAfter) headers["retry-after"] = retryAfter;

  return headers;
}

/**
 * Combines abort signals.
 *
 * `AbortSignal.any` exists from Node 20.3, which is above the engines floor in
 * package.json, but the fallback keeps this working if the runtime predates it
 * rather than failing at the first cancelled request.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const combine = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof combine === "function") return combine(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/** Reads the retry delay Horizon asked for, if any. */
export function retryAfterFrom(response: HorizonHttpResponse): number | undefined {
  return parseRetryAfterSeconds(response.headers["retry-after"]);
}

/** Convenience for transports that need to raise a fault directly. */
export function transportFault(message: string): HorizonFault {
  return new HorizonFault("network_error", message);
}
