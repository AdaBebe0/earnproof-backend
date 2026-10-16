import { createHash, createHmac, timingSafeEqual } from "crypto";

export class UnsupportedCredentialNumberError extends TypeError {
  constructor(value: number) {
    super(`Cannot canonicalize non-finite number: ${String(value)}`);
    this.name = "UnsupportedCredentialNumberError";
  }
}

/**
 * Standalone implementation for integrators. Keep this separate from the
 * server's canonicalizer so the golden vectors detect coupled regressions.
 */
export function canonicalCredential(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new UnsupportedCredentialNumberError(value);
  }
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sort((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function credentialHash(signingBase: string): string {
  return `sha256:${createHash("sha256").update(signingBase, "utf8").digest("hex")}`;
}

export function credentialSignature(secret: string, signingBase: string): string {
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(signingBase, "utf8")
    .digest("base64url")}`;
}

export function verifyCredentialSignature(
  secret: string,
  value: unknown,
  expectedHash: string,
  expectedSignature: string,
): boolean {
  const base = canonicalCredential(value);
  const actualHash = credentialHash(base);
  const actualSignature = credentialSignature(secret, base);
  return (
    actualHash.length === expectedHash.length &&
    actualSignature.length === expectedSignature.length &&
    timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash)) &&
    timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature))
  );
}
