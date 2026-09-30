/**
 * Canonicalizes a value for deterministic hashing by recursively sorting
 * object keys alphabetically, then JSON-serializing the result.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

/** Raised when a JavaScript-only numeric value has no unambiguous JSON form. */
export class UnsupportedCanonicalNumberError extends TypeError {
  constructor(value: number) {
    super(`Cannot canonicalize non-finite number: ${String(value)}`);
    this.name = "UnsupportedCanonicalNumberError";
  }
}

function sortObject(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    // JSON.stringify turns these into null. That makes a signed payload
    // dependent on an implicit coercion and can make distinct inputs collide.
    throw new UnsupportedCanonicalNumberError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortObject(record[key]);
        return sorted;
      }, {});
  }

  return value;
}
