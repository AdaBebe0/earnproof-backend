import { PAYLOAD_SHAPE_LIMITS } from "./request-limits";

/**
 * Structural inspection of a parsed request body.
 *
 * Iterative, never recursive. The whole point of the check is to survive a body
 * built to blow up a recursive walk, and a recursive checker would be the first
 * thing to fail — reporting a stack overflow as a 500 rather than the hostile
 * input as a 413.
 *
 * The walk is bounded twice: it stops as soon as a limit is exceeded, and it
 * stops at `maxNodes` regardless. A body that reaches either is refused, so
 * there is no case where the inspection is more expensive than the limits allow.
 */

export interface PayloadShapeLimits {
  readonly maxDepth: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxNodes: number;
}

/** A limit the payload exceeded, described without quoting the payload. */
export interface PayloadShapeViolation {
  readonly limit: "depth" | "arrayItems" | "stringLength" | "nodes";
  /** Safe to return to the client and to log: names the limit, not the value. */
  readonly message: string;
}

/**
 * Returns the first limit the value exceeds, or `undefined` if it is within all
 * of them.
 *
 * The message deliberately carries no fragment of the payload. An error that
 * echoes the input is how an oversized body ends up in a log line — which is
 * the resource-exhaustion problem again, one layer down, and a privacy problem
 * as well when the body was a credential.
 */
export function findPayloadShapeViolation(
  value: unknown,
  limits: PayloadShapeLimits = PAYLOAD_SHAPE_LIMITS,
): PayloadShapeViolation | undefined {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;

    if (++nodes > limits.maxNodes) {
      return {
        limit: "nodes",
        message: `Request body contains more than ${limits.maxNodes} values.`,
      };
    }

    if (typeof node === "string") {
      if (node.length > limits.maxStringLength) {
        return {
          limit: "stringLength",
          message: `Request body contains a string longer than ${limits.maxStringLength} characters.`,
        };
      }
      continue;
    }

    if (node === null || typeof node !== "object") continue;

    // Depth counts containers, not values: `{ a: { b: 1 } }` is two levels, so
    // a limit reads the way someone describing the JSON would say it.
    if (depth > limits.maxDepth) {
      return {
        limit: "depth",
        message: `Request body is nested deeper than ${limits.maxDepth} levels.`,
      };
    }

    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayItems) {
        return {
          limit: "arrayItems",
          message: `Request body contains an array with more than ${limits.maxArrayItems} items.`,
        };
      }

      for (const child of node) stack.push({ node: child, depth: depth + 1 });
      continue;
    }

    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }

  return undefined;
}
