import { createHmac } from "crypto";
import {
  UnsupportedCanonicalNumberError,
  canonicalize,
} from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import {
  loadCredentialVectors,
  runCredentialConformance,
} from "../../scripts/credential-verifier/conformance";
import { verifyCredentialSignature } from "../../scripts/credential-verifier/verifier";

const vectors = loadCredentialVectors();

describe("credential canonicalization golden vectors", () => {
  it("publishes a non-vacuous cross-runtime contract", () => {
    expect(vectors.positive.length).toBeGreaterThanOrEqual(8);
    expect(vectors.negative.length).toBeGreaterThanOrEqual(4);
  });

  it.each(vectors.positive.map((vector) => [vector.id, vector]))(
    "%s: server canonicalizer reproduces every frozen value",
    (_id, vector) => {
      const canonical = canonicalize(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(Buffer.from(canonical, "utf8").toString("base64")).toBe(vector.canonicalUtf8Base64);
      expect(`sha256:${sha256(canonical)}`).toBe(vector.credentialHash);
      expect(`hmac-sha256:${createHmac("sha256", vectors.secret).update(canonical, "utf8").digest("base64url")}`).toBe(vector.expectedSignature);
      expect(verifyCredentialSignature(vectors.secret, vector.input, vector.credentialHash, vector.expectedSignature)).toBe(true);
    },
  );

  it("does not normalize distinct Unicode representations", () => {
    const nfc = vectors.positive.find((vector) => vector.id === "unicode-nfc")!;
    const nfd = vectors.positive.find((vector) => vector.id === "unicode-nfd")!;
    expect(nfc.canonical).not.toBe(nfd.canonical);
    expect(nfc.credentialHash).not.toBe(nfd.credentialHash);
  });

  it("keeps array order and distinguishes omitted fields from null", () => {
    const array = vectors.positive.find((vector) => vector.id === "array-order")!;
    const omitted = vectors.positive.find((vector) => vector.id === "optional-omitted")!;
    const nullValue = vectors.positive.find((vector) => vector.id === "optional-null")!;
    expect(canonicalize(array.input)).toContain('["first","second","third"]');
    expect(omitted.credentialHash).not.toBe(nullValue.credentialHash);
  });

  it.each(vectors.negative.filter((vector) => vector.numericKind).map((vector) => [vector.id, vector]))(
    "%s: rejects non-finite numeric values",
    (_id, vector) => {
      const value = vector.numericKind === "NaN" ? Number.NaN : vector.numericKind === "Infinity" ? Infinity : -Infinity;
      expect(() => canonicalize({ value })).toThrow(UnsupportedCanonicalNumberError);
    },
  );

  it("rejects a payload tampered after signing", () => {
    const tampered = vectors.negative.find((vector) => vector.id === "tampered-payload")!;
    const source = vectors.positive.find((vector) => vector.id === tampered.source)!;
    const body = structuredClone(source.input) as Record<string, unknown>;
    let cursor = body;
    for (const segment of tampered.mutation!.path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
    cursor[tampered.mutation!.path.at(-1)!] = tampered.mutation!.value;
    expect(verifyCredentialSignature(vectors.secret, body, source.credentialHash, source.expectedSignature)).toBe(false);
  });

  it("runs every positive and negative vector through the independent verifier", () => {
    expect(runCredentialConformance()).toEqual([]);
  });
});
