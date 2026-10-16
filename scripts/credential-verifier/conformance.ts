import { readFileSync } from "fs";
import { join } from "path";
import {
  UnsupportedCredentialNumberError,
  canonicalCredential,
  credentialHash,
  credentialSignature,
  verifyCredentialSignature,
} from "./verifier";

export interface CredentialVector {
  id: string;
  input: Record<string, unknown>;
  canonical: string;
  canonicalUtf8Base64: string;
  credentialHash: string;
  signingBase: string;
  expectedSignature: string;
}

export interface CredentialVectors {
  version: number;
  algorithm: "HMAC-SHA256";
  secret: string;
  positive: CredentialVector[];
  negative: Array<{
    id: string;
    source?: string;
    mutation?: { path: string[]; value: unknown };
    numericKind?: "NaN" | "Infinity" | "-Infinity";
    expectedFailure: "signature_mismatch" | "unsupported_number";
  }>;
}

export function loadCredentialVectors(): CredentialVectors {
  return JSON.parse(
    readFileSync(join(process.cwd(), "test", "fixtures", "credentials", "canonicalization-vectors.json"), "utf8"),
  ) as CredentialVectors;
}

export function runCredentialConformance(): string[] {
  const vectors = loadCredentialVectors();
  const failures: string[] = [];
  for (const vector of vectors.positive) {
    const canonical = canonicalCredential(vector.input);
    if (canonical !== vector.canonical) failures.push(`${vector.id}: canonical`);
    if (Buffer.from(canonical, "utf8").toString("base64") !== vector.canonicalUtf8Base64) failures.push(`${vector.id}: utf8`);
    if (credentialHash(canonical) !== vector.credentialHash) failures.push(`${vector.id}: hash`);
    if (credentialSignature(vectors.secret, canonical) !== vector.expectedSignature) failures.push(`${vector.id}: signature`);
    if (!verifyCredentialSignature(vectors.secret, vector.input, vector.credentialHash, vector.expectedSignature)) failures.push(`${vector.id}: verify`);
  }
  for (const vector of vectors.negative) {
    if (!vector.numericKind) continue;
    const value = vector.numericKind === "NaN" ? Number.NaN : vector.numericKind === "Infinity" ? Infinity : -Infinity;
    try {
      canonicalCredential({ value });
      failures.push(`${vector.id}: accepted unsupported number`);
    } catch (error) {
      if (!(error instanceof UnsupportedCredentialNumberError)) failures.push(`${vector.id}: wrong error`);
    }
  }
  return failures;
}

if (require.main === module) {
  const failures = runCredentialConformance();
  if (failures.length) {
    console.error(`Credential conformance failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("Credential conformance passed.");
}
