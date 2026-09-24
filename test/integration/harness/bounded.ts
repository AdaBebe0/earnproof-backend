import { redactErrorInPlace, safe } from "./redaction";

/**
 * Deadlines for harness operations.
 *
 * Every step that talks to PostgreSQL or spawns the Prisma CLI is bounded. An
 * unbounded harness fails in the worst possible way: a misconfigured host, a
 * server that accepts the TCP connection but never completes the handshake, or
 * a `DROP DATABASE` blocked behind a leaked connection all present as a CI job
 * that hangs until the runner's own timeout kills it — tens of minutes later,
 * with no output identifying the step.
 *
 * A deadline converts each of those into a named failure at a known step.
 */

export class HarnessTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${safe(label)} did not finish within ${timeoutMs}ms`);
    this.name = "HarnessTimeoutError";
  }
}

/**
 * Rejects with {@link HarnessTimeoutError} if `operation` outlives `timeoutMs`.
 *
 * The underlying promise is not cancellable — nothing in the Prisma client is —
 * so the timer is unreferenced and its rejection is absorbed if it loses the
 * race. Leaving the timer referenced would keep the Node event loop alive after
 * a successful run and turn a passing suite into one that never exits.
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HarnessTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    // A failure here is the harness's own, and its message routinely carries the
    // connection string Prisma was configured with.
    throw redactErrorInPlace(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
