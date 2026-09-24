import { WebhookSigningService } from "./webhook-signing.service";

describe("WebhookSigningService", () => {
  const service = new WebhookSigningService();
  const secret = "test-signing-secret-32-bytes-pad!";
  const timestamp = 1724400000;
  const deliveryId = "delivery_abc123";
  const body = '{"specVersion":"1","id":"delivery_abc123","event":"proof.created"}';

  describe("sign", () => {
    it("produces a v1= prefixed hex signature", () => {
      const sig = service.sign(secret, timestamp, deliveryId, body);
      expect(sig).toMatch(/^v1=[a-f0-9]{64}$/);
    });

    it("is deterministic for the same inputs", () => {
      const sig1 = service.sign(secret, timestamp, deliveryId, body);
      const sig2 = service.sign(secret, timestamp, deliveryId, body);
      expect(sig1).toBe(sig2);
    });

    it("changes when the secret changes", () => {
      const sig1 = service.sign(secret, timestamp, deliveryId, body);
      const sig2 = service.sign("different-secret", timestamp, deliveryId, body);
      expect(sig1).not.toBe(sig2);
    });

    it("changes when the body is tampered", () => {
      const sig1 = service.sign(secret, timestamp, deliveryId, body);
      const sig2 = service.sign(secret, timestamp, deliveryId, body + " ");
      expect(sig1).not.toBe(sig2);
    });

    it("changes when the timestamp changes", () => {
      const sig1 = service.sign(secret, timestamp, deliveryId, body);
      const sig2 = service.sign(secret, timestamp + 1, deliveryId, body);
      expect(sig1).not.toBe(sig2);
    });

    it("changes when the deliveryId changes", () => {
      const sig1 = service.sign(secret, timestamp, deliveryId, body);
      const sig2 = service.sign(secret, timestamp, "different_id", body);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("verify", () => {
    it("accepts a valid signature", () => {
      const sig = service.sign(secret, timestamp, deliveryId, body);
      expect(service.verify(secret, timestamp, deliveryId, body, sig)).toBe(true);
    });

    it("rejects a tampered payload", () => {
      const sig = service.sign(secret, timestamp, deliveryId, body);
      expect(
        service.verify(secret, timestamp, deliveryId, body + "tampered", sig),
      ).toBe(false);
    });

    it("rejects a signature produced with a different secret", () => {
      const sig = service.sign("wrong-secret", timestamp, deliveryId, body);
      expect(service.verify(secret, timestamp, deliveryId, body, sig)).toBe(false);
    });

    it("rejects a completely fabricated signature", () => {
      expect(
        service.verify(secret, timestamp, deliveryId, body, "v1=aabbccdd"),
      ).toBe(false);
    });

    it("rejects an empty signature string", () => {
      expect(service.verify(secret, timestamp, deliveryId, body, "")).toBe(false);
    });

    it("is resistant to length-extension (different length strings never pass constant-time check)", () => {
      const sig = service.sign(secret, timestamp, deliveryId, body);
      // Append garbage to a correct signature
      expect(
        service.verify(secret, timestamp, deliveryId, body, sig + "00"),
      ).toBe(false);
    });
  });
});
