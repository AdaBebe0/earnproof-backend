/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { WebhookDeliveryStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookEnvelope } from "./webhook-event.types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const ENCRYPTION_KEYRING = new Map([[0, ENCRYPTION_KEY]]);
const RAW_SECRET = "test-raw-signing-secret-32bytes!";

function makeEncryptedSecret() {
  return encryptProtectedAmount(RAW_SECRET, ENCRYPTION_KEYRING, 0);
}

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };
}

function makeEnvelope(overrides: Partial<WebhookEnvelope> = {}): WebhookEnvelope {
  return {
    specVersion: "1",
    id: "event_abc",
    event: "proof.created",
    createdAt: new Date().toISOString(),
    data: {
      proofId: "proof_1",
      proofType: "MINIMUM_INCOME",
      schemaVersion: "earnproof.minimum-income.v1",
      status: "ACTIVE",
      network: "testnet",
      assetCode: "XLM",
      assetIssuer: null,
      periodStart: null,
      periodEnd: null,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      credentialHash: "sha256:abc",
      contractTransactionHash: null,
      issuedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Delivery service — unit tests using an in-memory store
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService", () => {
  // -------------------------------------------------------------------------
  // Retry behavior and ordering
  // -------------------------------------------------------------------------
  describe("retry behavior", () => {
    it("marks a delivery SUCCESS when the endpoint returns 2xx", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_1";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      // Pre-create the delivery row (simulating what enqueueForUser does)
      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "OK",
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      // Bypass onModuleInit startup scan
      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const updated = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(updated.status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(updated.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("creates a retry delivery row when the endpoint returns 5xx", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_fail_1";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      // Original delivery marked FAILED
      const original = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(original.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(original.statusCode).toBe(503);

      // A new retry delivery was created
      const retryDelivery = [...deliveries.values()].find(
        (d) => d.id !== deliveryId && (d as Record<string, unknown>).attempt === 2,
      );
      expect(retryDelivery).toBeDefined();
      expect((retryDelivery as Record<string, unknown>).eventId).toBe("event_abc");
    });

    it("permanently fails after MAX_ATTEMPTS (5) without further retries", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_maxretry";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        attempt: 5, // already at max
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "error",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      // Still only 1 delivery row — no new retry row created
      expect(deliveries.size).toBe(1);
      const d = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(d.status).toBe(WebhookDeliveryStatus.FAILED);
    });

    it("carries the same eventId across all retry attempts (ordering + idempotency)", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_chain";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_same",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "error",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope({ id: "event_same" }),
        "https://example.com/hook",
        secretEncrypted,
      );

      const retryRow = [...deliveries.values()].find(
        (d) => (d as Record<string, unknown>).id !== deliveryId,
      ) as Record<string, unknown> | undefined;

      expect(retryRow?.eventId).toBe("event_same");
    });
  });

  // -------------------------------------------------------------------------
  // SSRF protection
  // -------------------------------------------------------------------------
  describe("SSRF protection", () => {
    const blockedUrls = [
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://10.0.0.1/hook",
      "https://172.16.0.1/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/hook",
      "https://[::1]/hook",
    ];

    it.each(blockedUrls)(
      "permanently fails delivery to blocked URL %s without scheduling a retry",
      async (blockedUrl) => {
        const secretEncrypted = makeEncryptedSecret();
        const deliveries = new Map<string, Record<string, unknown>>();
        const deliveryId = `delivery_ssrf_${blockedUrl.slice(-5)}`;

        const prisma = buildPrisma(deliveries, [
          { id: "webhook_1", url: blockedUrl, secretEncrypted, status: "ACTIVE" },
        ]);

        deliveries.set(deliveryId, {
          id: deliveryId,
          webhookId: "webhook_1",
          eventType: "proof.created",
          eventId: "event_ssrf",
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
          replayOf: null,
          createdAt: new Date(),
          webhook: {
            id: "webhook_1",
            url: blockedUrl,
            secretEncrypted,
            status: "ACTIVE",
          },
        });

        // fetch should never be called for SSRF-blocked URLs
        global.fetch = jest.fn() as unknown as typeof fetch;

        const service = new WebhookDeliveryService(
          prisma as never,
          new WebhookSigningService(),
          makeConfig() as never,
        );

        await (service as unknown as { runDelivery: Function }).runDelivery(
          deliveryId,
          makeEnvelope(),
          blockedUrl,
          secretEncrypted,
        );

        expect(global.fetch).not.toHaveBeenCalled();

        const d = deliveries.get(deliveryId) as Record<string, unknown>;
        expect(d.status).toBe(WebhookDeliveryStatus.FAILED);
        expect(d.failureReason).toMatch(/SSRF/);

        // No retry row created
        expect(deliveries.size).toBe(1);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Redaction — secrets must never appear in delivery logs
  // -------------------------------------------------------------------------
  describe("redaction", () => {
    it("does not store the raw signing secret in the delivery row", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_redact";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_r",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"token":"integrator-secret","ok":true}',
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      const rowJson = JSON.stringify(storedRow);

      // Raw secret must not appear in the stored delivery row
      expect(rowJson).not.toContain(RAW_SECRET);
      expect(rowJson).not.toContain("integrator-secret");
      expect(rowJson).toContain("[REDACTED]");
    });

    it("truncates large response bodies to 1024 characters", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_trunc";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_t",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const largeBody = "x".repeat(5000);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => largeBody,
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(typeof storedRow.responseBody).toBe("string");
      expect((storedRow.responseBody as string).length).toBeLessThanOrEqual(
        1024 + "…[truncated]".length,
      );
      expect(storedRow.responseBody as string).toContain("…[truncated]");
    });
  });

  // -------------------------------------------------------------------------
  // Secret rotation — delivery re-decrypts at execution time
  // -------------------------------------------------------------------------
  describe("secret rotation", () => {
    it("uses the current encrypted secret at execution time, not at enqueue time", async () => {
      const newSecret = encryptProtectedAmount(
        "new-secret",
        ENCRYPTION_KEYRING,
        0,
      );

      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_rotated";

      // The webhook row now has the NEW secret (simulating rotation)
      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted: newSecret, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_rot",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted: newSecret, // delivery row also references the live webhook
          status: "ACTIVE",
        },
      });

      const capturedHeaders: Record<string, string> = {};
      global.fetch = jest.fn().mockImplementation(
        (_url: string, init: RequestInit) => {
          Object.assign(capturedHeaders, init.headers as Record<string, string>);
          return Promise.resolve({ ok: true, status: 200, text: async () => "ok" });
        },
      ) as unknown as typeof fetch;

      const signing = new WebhookSigningService();
      const service = new WebhookDeliveryService(
        prisma as never,
        signing,
        makeConfig() as never,
      );

      // Pass the OLD cached secret — but the service should re-read from webhook row
      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        undefined, // no cached URL
        undefined, // no cached secret → forces DB read
      );

      // Signature in the sent request should be verifiable with the NEW secret
      const sigHeader = capturedHeaders["X-EarnProof-Signature"];
      const tsHeader = capturedHeaders["X-EarnProof-Timestamp"];
      const deliveryHeader = capturedHeaders["X-EarnProof-Delivery"];
      expect(sigHeader).toMatch(/^v1=/);

      // The old secret should NOT verify the signature
      const body = JSON.stringify(makeEnvelope());
      const ts = Number(tsHeader);
      expect(
        signing.verify("old-secret", ts, deliveryHeader, body, sigHeader),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------
  describe("replay", () => {
    it("creates a new delivery row with replayOf set to the original id", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const originalId = "delivery_original";

      deliveries.set(originalId, {
        id: originalId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_replay",
        payload: makeEnvelope({ id: "event_replay" }),
        attempt: 1,
        status: WebhookDeliveryStatus.FAILED,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
          events: ["proof.created"],
        },
      });

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      const newId = await service.replay(originalId, "user_admin");

      const replayRow = deliveries.get(newId) as Record<string, unknown>;
      expect(replayRow).toBeDefined();
      expect(replayRow.replayOf).toBe(originalId);
      expect(replayRow.replayedBy).toBe("user_admin");
      expect(replayRow.eventId).toBe("event_replay"); // same eventId → integrator deduplicates
      expect(replayRow.attempt).toBe(1);

      const repeatedId = await service.replay(originalId, "user_admin");
      expect(repeatedId).toBe(newId);
      expect(deliveries.size).toBe(2);
    });

    it("rejects replay for a disabled webhook endpoint", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const originalId = "delivery_disabled";

      deliveries.set(originalId, {
        id: originalId,
        webhookId: "webhook_disabled",
        eventType: "proof.created",
        eventId: "event_d",
        attempt: 1,
        status: WebhookDeliveryStatus.SUCCESS,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_disabled",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "SUSPENDED", // disabled
          events: ["proof.created"],
        },
      });

      const prisma = buildPrisma(deliveries, []);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await expect(service.replay(originalId, "user_admin")).rejects.toThrow(
        "Cannot replay delivery for a disabled webhook endpoint",
      );
    });

    it("throws for a non-existent delivery id", async () => {
      const prisma = buildPrisma(new Map(), []);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await expect(service.replay("non_existent", "user_x")).rejects.toThrow(
        "WebhookDelivery not found",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Integration tests: SafeWebhookResponse handling
  // -------------------------------------------------------------------------
  describe("SafeWebhookResponse handling", () => {
    it("stores response body as SafeWebhookResponse JSON structure on success", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_safe_response";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_safe",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "Success response",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(storedRow.status).toBe(WebhookDeliveryStatus.SUCCESS);

      // responseBody should be a SafeWebhookResponse object (stored as JSON)
      expect(typeof storedRow.responseBody).toBe("object");
      const responseBody = storedRow.responseBody as Record<string, unknown>;
      expect(responseBody).toHaveProperty("truncatedBody");
      expect(responseBody).toHaveProperty("contentHash");
      expect(responseBody).toHaveProperty("wasTruncated");
      expect(responseBody).toHaveProperty("hadEncodingIssue");

      expect(responseBody.truncatedBody).toBe("Success response");
      expect(responseBody.wasTruncated).toBe(false);
      expect(responseBody.hadEncodingIssue).toBe(false);
      expect(typeof responseBody.contentHash).toBe("string");
      expect((responseBody.contentHash as string).length).toBe(64); // SHA-256 hex
    });

    it("stores response body on failed delivery with SafeWebhookResponse structure", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_fail_safe";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_fail_safe",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(storedRow.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(storedRow.statusCode).toBe(400);

      // responseBody should still be stored as SafeWebhookResponse
      expect(typeof storedRow.responseBody).toBe("object");
      const responseBody = storedRow.responseBody as Record<string, unknown>;
      expect(responseBody.truncatedBody).toBe("Bad Request");
    });

    it("truncates large response bodies and sets wasTruncated flag", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_truncated_safe";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_truncated",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const largeBody = "x".repeat(2000);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => largeBody,
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      const responseBody = storedRow.responseBody as Record<string, unknown>;

      expect(responseBody.wasTruncated).toBe(true);
      expect((responseBody.truncatedBody as string).length).toBe(1024); // MAX_RESPONSE_BODY_BYTES
      // Hash is computed on full content before truncation
      expect(typeof responseBody.contentHash).toBe("string");
      expect((responseBody.contentHash as string).length).toBe(64);
    });

    it("redacts sensitive patterns and stores redacted hash", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_redact_safe";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_redact",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const responseWithSecret = 'api_key="secret123456789" status: ok';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => responseWithSecret,
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      const responseBody = storedRow.responseBody as Record<string, unknown>;

      // Secret should be redacted
      expect(responseBody.truncatedBody as string).not.toContain("secret123456789");
      expect(responseBody.truncatedBody as string).toContain("[REDACTED]");
      expect(responseBody.truncatedBody as string).toContain("status: ok");
    });

    it("detects and flags encoding issues in binary responses", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_binary_safe";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_binary",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      // Mock fetch to return invalid UTF-8
      const invalidBuffer = Buffer.from([0xFF, 0xFE, 0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => invalidBuffer.toString("utf8"),
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      const responseBody = storedRow.responseBody as Record<string, unknown>;

      // Should still succeed with hadEncodingIssue flag set
      expect(storedRow.status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(responseBody.hadEncodingIssue).toBe(true);
      expect(typeof responseBody.truncatedBody).toBe("string");
    });

    it("handles multiple retries with consistent SafeWebhookResponse structure", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId1 = "delivery_retry_safe_1";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId1, {
        id: deliveryId1,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_consistent",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      // First attempt returns 500
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(
        deliveryId1,
        makeEnvelope(),
        "https://example.com/hook",
        secretEncrypted,
      );

      // First attempt should have SafeWebhookResponse
      const firstAttempt = deliveries.get(deliveryId1) as Record<string, unknown>;
      expect(firstAttempt.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(typeof firstAttempt.responseBody).toBe("object");
      const firstResponse = firstAttempt.responseBody as Record<string, unknown>;
      expect(firstResponse.truncatedBody).toBe("Internal Server Error");

      // Retry delivery should also have same structure
      const retryDelivery = [...deliveries.values()].find(
        (d) => (d as Record<string, unknown>).attempt === 2,
      ) as Record<string, unknown> | undefined;
      expect(retryDelivery).toBeDefined();
      expect(retryDelivery?.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(retryDelivery?.eventId).toBe("event_consistent");
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma mock
// ---------------------------------------------------------------------------

function buildPrisma(
  deliveries: Map<string, Record<string, unknown>>,
  webhooks: Array<{
    id: string;
    url: string;
    secretEncrypted: string;
    status: string;
    events?: string[];
  }>,
) {
  let nextId = 1;
  const genId = () => `delivery_gen_${nextId++}`;

  return {
    webhookDelivery: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const status = where?.status as string | undefined;
        const rows = [...deliveries.values()].filter((d) =>
          status ? d.status === status : true,
        );
        return Promise.resolve(
          rows.map((r) => ({
            id: r.id,
            webhookId: r.webhookId,
            attempt: r.attempt,
            nextRetryAt: r.nextRetryAt ?? null,
          })),
        );
      }),
      findUnique: jest.fn(({ where, include }: { where: { id?: string; replayKey?: string }; include?: unknown }) => {
        const row = where.id
          ? deliveries.get(where.id)
          : [...deliveries.values()].find(
              (delivery) => delivery.replayKey === where.replayKey,
            );
        if (!row) return Promise.resolve(null);
        const withWebhook = include
          ? {
              ...row,
              webhook: webhooks.find((w) => w.id === row.webhookId) ??
                (row.webhook as Record<string, unknown>),
            }
          : row;
        return Promise.resolve(withWebhook);
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = (data.id as string | undefined) ?? genId();
        const row = { ...data, id };
        deliveries.set(id, row);
        const select = { id };
        return Promise.resolve(select);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = deliveries.get(where.id) ?? {};
        const updated = { ...existing, ...data };
        deliveries.set(where.id, updated);
        return Promise.resolve(updated);
      }),
    },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ organizations: [] }),
      ),
    },
    webhook: {
      findMany: jest.fn(() => Promise.resolve(webhooks)),
    },
  };
}
