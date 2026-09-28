import { redactErrorInPlace } from "./redaction";

/**
 * Per-test-file setup: bounded timeouts and redaction of assertion failures.
 *
 * Two redaction points cover the two ways a secret reaches test output.
 *
 * 1. Errors thrown by the database client — handled in `database.ts`, at the
 *    client boundary, because that is where Prisma attaches the datasource and
 *    the failing query.
 *
 * 2. Assertion failures — handled here. `expect(row).toEqual(expected)` prints
 *    a diff of both objects, so a mismatch on any field of a `Payment` prints
 *    `amountEncrypted`, and a mismatch on an `AuthSession` prints `tokenHash`.
 *    No amount of care inside individual tests prevents that, because the value
 *    is printed by the matcher, not by the test.
 */

/**
 * Default per-test deadline.
 *
 * Higher than the Jest default of 5s because these tests wait on a real
 * database, and low enough that a test blocked on a lock fails rather than
 * running until the CI job is killed.
 */
const TEST_TIMEOUT_MS = Number(process.env.INTEGRATION_TEST_TIMEOUT_MS ?? 30_000);

jest.setTimeout(TEST_TIMEOUT_MS);

/** Marker so a re-imported setup file does not wrap `expect` twice. */
const INSTALLED = Symbol.for("earnproof.integration.redactedExpect");

function rethrowRedacted(error: unknown): never {
  throw redactErrorInPlace(error);
}

/**
 * Wraps a matcher target so any error it throws is redacted.
 *
 * `.not`, `.resolves` and `.rejects` are objects carrying further matchers, so
 * object-valued properties are wrapped recursively; everything else is returned
 * untouched.
 */
function wrapMatchers<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);

      if (typeof value === "function") {
        return (...args: unknown[]) => {
          try {
            const result = (value as (...a: unknown[]) => unknown).apply(object, args);
            return result instanceof Promise ? result.catch(rethrowRedacted) : result;
          } catch (error) {
            rethrowRedacted(error);
          }
        };
      }

      if (value && typeof value === "object") {
        return wrapMatchers(value as object);
      }

      return value;
    },
  });
}

/**
 * Replaces the global `expect` with one whose failures are redacted.
 *
 * The replacement forwards to the original and copies every own property
 * (`expect.extend`, `expect.any`, `expect.getState`, and the symbol-keyed
 * internals Jest reads), so custom matchers and expectation state behave
 * exactly as before. Only the error path differs.
 */
function installFailureRedaction(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.expect as
    | (((...args: unknown[]) => object) & Record<PropertyKey, unknown>)
    | undefined;

  if (typeof original !== "function") return;
  if (original[INSTALLED]) return;

  const wrapped = ((...args: unknown[]) =>
    wrapMatchers(original(...args))) as unknown as Record<PropertyKey, unknown>;

  for (const key of Reflect.ownKeys(original)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(wrapped, key, descriptor);
  }

  wrapped[INSTALLED] = true;
  globals.expect = wrapped;
}

installFailureRedaction();
