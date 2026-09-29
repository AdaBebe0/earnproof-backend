import { findPayloadShapeViolation } from "./payload-shape";
import { PAYLOAD_SHAPE_LIMITS } from "./request-limits";

/**
 * The structural walker, in isolation.
 *
 * The HTTP tests in `test/security/` prove the limits are wired in. These prove
 * the walker itself is right at its boundaries and, most importantly, that it
 * survives the input it exists to reject: a checker that overflows on a deep
 * body turns hostile input into a 500.
 */

const LIMITS = {
  maxDepth: 4,
  maxArrayItems: 3,
  maxStringLength: 8,
  maxNodes: 20,
};

/** A value nested `depth` container levels deep, built iteratively. */
function nested(depth: number): unknown {
  let node: unknown = 1;
  for (let index = 0; index < depth; index += 1) node = { child: node };
  return node;
}

describe("findPayloadShapeViolation", () => {
  it("accepts a value inside every limit", () => {
    expect(
      findPayloadShapeViolation(
        { name: "ok", ids: ["a", "b"], nested: { deeper: { x: 1 } } },
        LIMITS,
      ),
    ).toBeUndefined();
  });

  it("counts depth in containers, not values", () => {
    // `{ a: { b: 1 } }` is two levels, which is how anyone describing the JSON
    // would count it. A value at the bottom does not add one.
    expect(findPayloadShapeViolation(nested(4), LIMITS)).toBeUndefined();
    expect(findPayloadShapeViolation(nested(5), LIMITS)).toMatchObject({
      limit: "depth",
    });
  });

  it("reports an array over the item limit", () => {
    expect(findPayloadShapeViolation({ ids: [1, 2, 3] }, LIMITS)).toBeUndefined();
    expect(findPayloadShapeViolation({ ids: [1, 2, 3, 4] }, LIMITS)).toMatchObject(
      { limit: "arrayItems" },
    );
  });

  it("reports a string over the length limit, wherever it sits", () => {
    expect(
      findPayloadShapeViolation({ a: { b: ["x".repeat(9)] } }, LIMITS),
    ).toMatchObject({ limit: "stringLength" });
  });

  it("reports a value count over the node limit", () => {
    // Neither deep nor long, but expensive to validate: the node limit is the
    // only bound that catches this shape.
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 25; index += 1) wide[`k${index}`] = index;

    expect(findPayloadShapeViolation(wide, LIMITS)).toMatchObject({
      limit: "nodes",
    });
  });

  it("never quotes the payload in its message", () => {
    const violation = findPayloadShapeViolation(
      { secretish: "s".repeat(50) },
      LIMITS,
    );

    expect(violation?.message).not.toContain("s".repeat(10));
    expect(violation?.message).toContain("8 characters");
  });

  it("handles a body deep enough to overflow a recursive walker", () => {
    // 200,000 levels. A recursive checker throws RangeError here, which would
    // surface to the client as an internal error rather than as a refusal.
    expect(() => findPayloadShapeViolation(nested(200_000), LIMITS)).not.toThrow();
    expect(findPayloadShapeViolation(nested(200_000), LIMITS)).toMatchObject({
      limit: "depth",
    });
  });

  it("accepts primitives and null", () => {
    for (const value of [null, undefined, 1, true, "short"]) {
      expect(findPayloadShapeViolation(value, LIMITS)).toBeUndefined();
    }
  });

  it("defaults to the application's configured limits", () => {
    const withinDefaults = { ids: Array(500).fill("payment-1") };

    expect(findPayloadShapeViolation(withinDefaults)).toBeUndefined();
    expect(
      findPayloadShapeViolation({
        ids: Array(PAYLOAD_SHAPE_LIMITS.maxArrayItems + 1).fill("a"),
      }),
    ).toMatchObject({ limit: "arrayItems" });
  });
});
