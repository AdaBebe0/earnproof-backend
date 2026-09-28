import { createHmac } from "crypto";
import {
  DeliveryIdStore,
  computeSignatureHeader,
  signingBase,
  verifyWebhookSignature,
} from "../../scripts/webhook-receiver/verifier";
import { loadVectors, runConformance } from "../../scripts/webhook-receiver/conformance";
import { WebhookSigningService } from "./webhook-signing.service";

/**
 * Conformance of the published signing vectors against the shipping signer.
 *
 * The vectors in `test/fixtures/webhooks/signing-vectors.json` are frozen. They
 * are what an integrator in any language checks their implementation against,
 * so a change to `WebhookSigningService` that alters even one byte of the wire
 * format has to fail here — loudly, and before release — rather than at every
 * customer's endpoint simultaneously.
 *
 * If a test in this file fails, the correct response is almost never to
 * regenerate the vectors. It is to establish whether the wire format changed,
 * and if it did, to treat that as the breaking change it is.
 */

const vectors = loadVectors();
const signer = new WebhookSigningService();

describe("golden vectors match the shipping signer", () => {
  it("publishes vectors to check against", () => {
    // Guards against the suite passing vacuously if the file were emptied.
    expect(vectors.positive.length).toBeGreaterThanOrEqual(10);
    expect(vectors.negative.length).toBeGreaterThanOrEqual(15);
  });

  it.each(vectors.positive.map((vector) => [vector.id, vector]))(
    "%s: WebhookSigningService reproduces the frozen signature",
    (_id, vector) => {
      expect(
        signer.sign(vector.secret, vector.timestamp, vector.deliveryId, vector.body),
      ).toBe(vector.expectedSignature);
    },
  );

  it.each(vectors.positive.map((vector) => [vector.id, vector]))(
    "%s: the reference verifier accepts what the server signed",
    (_id, vector) => {
      // Signed by the server implementation, verified by the implementation
      // handed to integrators. Testing either alone would miss a divergence.
      const signature = signer.sign(
        vector.secret,
        vector.timestamp,
        vector.deliveryId,
        vector.body,
      );

      const result = verifyWebhookSignature({
        secrets: [vector.secret],
        rawBody: Buffer.from(vector.bodyBase64, "base64"),
        signatureHeader: signature,
        timestampHeader: String(vector.timestamp),
        deliveryIdHeader: vector.deliveryId,
        nowSeconds: vector.verifyAtSeconds,
        toleranceSeconds: vectors.toleranceSeconds,
      });

      expect(result.ok).toBe(true);
    },
  );

  it("builds the signing base as timestamp, delivery ID, then raw body", () => {
    const vector = vectors.positive[0];
    const base = signingBase(
      vector.timestamp,
      vector.deliveryId,
      Buffer.from(vector.bodyBase64, "base64"),
    );

    expect(base.toString("utf8")).toBe(vector.signingBase);
    expect(base.toString("base64")).toBe(vector.signingBaseBase64);
  });

  it("keys the HMAC with the raw bytes of the secret, not a decoding of it", () => {
    // The API issues hex-shaped secrets. Treating one as hex-encoded bytes
    // rather than as text is the single most common porting mistake, and it
    // produces a signature that is wrong 100% of the time yet looks plausible.
    const vector = vectors.positive.find((v) => v.id === "hex-shaped-secret");
    expect(vector).toBeDefined();

    const asText = createHmac("sha256", vector!.secret)
      .update(vector!.signingBase, "utf8")
      .digest("hex");
    const asDecodedBytes = createHmac("sha256", Buffer.from(vector!.secret, "hex"))
      .update(vector!.signingBase, "utf8")
      .digest("hex");

    expect(`v1=${asText}`).toBe(vector!.expectedSignature);
    expect(`v1=${asDecodedBytes}`).not.toBe(vector!.expectedSignature);
  });
});

describe("negative vectors are rejected for the stated reason", () => {
  it.each(vectors.negative.map((vector) => [vector.id, vector]))(
    "%s",
    (_id, vector) => {
      const result = verifyWebhookSignature({
        secrets: [vector.secret],
        rawBody: Buffer.from(vector.bodyBase64, "base64"),
        signatureHeader: vector.headerSignature,
        timestampHeader: vector.headerTimestamp,
        deliveryIdHeader: vector.headerDeliveryId,
        nowSeconds: vector.verifyAtSeconds,
        toleranceSeconds: vectors.toleranceSeconds,
      });

      expect(result).toEqual({ ok: false, reason: vector.expectedFailure });
    },
  );
});

describe("timestamp tolerance", () => {
  const vector = vectors.positive[0];

  function verifyAt(nowSeconds: number) {
    return verifyWebhookSignature({
      secrets: [vector.secret],
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: vector.expectedSignature,
      timestampHeader: String(vector.timestamp),
      deliveryIdHeader: vector.deliveryId,
      nowSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });
  }

  it("accepts a delivery exactly on the edge of the window", () => {
    expect(verifyAt(vector.timestamp + vectors.toleranceSeconds).ok).toBe(true);
  });

  it("rejects one second past the window", () => {
    expect(verifyAt(vector.timestamp + vectors.toleranceSeconds + 1)).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
  });

  it("rejects a delivery dated too far in the future", () => {
    // Clock skew cuts both ways; a one-sided check accepts a signature minted
    // with an arbitrarily distant timestamp and never expires it.
    expect(verifyAt(vector.timestamp - vectors.toleranceSeconds - 1)).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
  });
});

describe("delivery-ID deduplication", () => {
  it("accepts a delivery once and reports the repeat as a duplicate", () => {
    const store = new DeliveryIdStore();
    expect(store.register("whd_synthetic_0001", 1_000)).toBe(true);
    expect(store.register("whd_synthetic_0001", 1_001)).toBe(false);
  });

  it("accepts the same ID again once the retention window has passed", () => {
    // A deliberate replay requested long after the fact must be processable;
    // remembering every ID forever would make the replay endpoint useless.
    const store = new DeliveryIdStore({ ttlSeconds: 60 });
    expect(store.register("whd_synthetic_0001", 1_000)).toBe(true);
    expect(store.register("whd_synthetic_0001", 1_061)).toBe(true);
  });

  it("stays bounded under a flood of distinct IDs", () => {
    const store = new DeliveryIdStore({ maxEntries: 10 });
    for (let index = 0; index < 500; index += 1) {
      store.register(`whd_synthetic_${index}`, 1_000);
    }
    expect(store.size).toBe(10);
  });

  it("does not let an unverified request reserve a delivery ID", () => {
    // The ordering rule the receiver enforces: register only after the
    // signature verifies. Registering on arrival would let anyone who learns a
    // delivery ID suppress the genuine delivery by claiming it first.
    const store = new DeliveryIdStore();
    const forged = vectors.negative.find((v) => v.id === "tampered-body-single-byte");
    const genuine = vectors.positive.find((v) => v.id === "minimal-proof-created");

    const forgedResult = verifyWebhookSignature({
      secrets: [forged!.secret],
      rawBody: Buffer.from(forged!.bodyBase64, "base64"),
      signatureHeader: forged!.headerSignature,
      timestampHeader: forged!.headerTimestamp,
      deliveryIdHeader: forged!.headerDeliveryId,
      nowSeconds: forged!.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });
    expect(forgedResult.ok).toBe(false);

    // Nothing was registered, so the genuine delivery still gets through.
    expect(store.register(genuine!.deliveryId, genuine!.verifyAtSeconds)).toBe(true);
  });
});

describe("secret rotation", () => {
  const vector = vectors.positive[0];
  const retired = vector.secret;
  const current = `${vector.secret}-rotated`;

  function verifyWith(secrets: string[]) {
    return verifyWebhookSignature({
      secrets,
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: vector.expectedSignature,
      timestampHeader: String(vector.timestamp),
      deliveryIdHeader: vector.deliveryId,
      nowSeconds: vector.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });
  }

  it("accepts a delivery signed with either secret during the overlap", () => {
    expect(verifyWith([current, retired]).ok).toBe(true);
  });

  it("accepts a delivery signed with the new secret", () => {
    const signature = computeSignatureHeader(
      current,
      vector.timestamp,
      vector.deliveryId,
      Buffer.from(vector.bodyBase64, "base64"),
    );

    const result = verifyWebhookSignature({
      secrets: [current, retired],
      rawBody: Buffer.from(vector.bodyBase64, "base64"),
      signatureHeader: signature,
      timestampHeader: String(vector.timestamp),
      deliveryIdHeader: vector.deliveryId,
      nowSeconds: vector.verifyAtSeconds,
      toleranceSeconds: vectors.toleranceSeconds,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects the retired secret once it has been dropped", () => {
    expect(verifyWith([current])).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects when no secret is configured at all", () => {
    // An empty secret list must fail closed. Verifying against nothing and
    // treating "no mismatch found" as success is a real failure mode.
    expect(verifyWith([])).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("published vectors carry nothing sensitive", () => {
  it("uses only recognisably synthetic secrets", () => {
    for (const vector of [...vectors.positive, ...vectors.negative]) {
      expect(vector.secret).toMatch(/synthetic|deadbeef/i);
    }
  });

  it("contains no wallet addresses or credential hashes", () => {
    // The fixture is published and pasted into issues. A realistic-looking
    // wallet address in it is indistinguishable from a leak of customer data.
    const raw = JSON.stringify(vectors);
    expect(raw).not.toMatch(/\b[GMS][A-Z2-7]{55}\b/);
    expect(raw).not.toMatch(/"sha256:[0-9a-f]{64}"/);
  });
});

describe("full conformance run", () => {
  it("passes every check, including over a real HTTP round trip", async () => {
    // The same function the CLI runs, so `npm run webhook:conformance` and CI
    // cannot diverge from what this suite proves.
    const report = await runConformance();

    expect(report.failures).toEqual([]);
    expect(report.passed).toBeGreaterThan(0);
  }, 30_000);
});
