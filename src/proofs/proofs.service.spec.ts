import {
  AnchoringOperation,
  AnchoringStatus,
  PaymentClassification,
  ProofStatus,
  ProofType,
  ResourceStatus,
  VerificationResult,
} from "@prisma/client";
import { sha256 } from "../common/crypto/hash";
import { ProofsService } from "./proofs.service";
import { VerificationEventService } from "../audit/verification-event.service";
import { AttestationsService } from "../attestations/attestations.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }

  if (value && typeof value === "object") {
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

/**
 * Config factory.
 * @param anchoringEnabled - CONTRACT_ANCHORING_ENABLED
 * @param anchoringRequired - CONTRACT_ANCHORING_REQUIRED
 */
function makeConfig(anchoringEnabled = false, anchoringRequired = false) {
  return {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        credentialSigningSecret: "test-signing-secret",
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "stellar.network": "testnet",
      };
      return values[key];
    }),
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return anchoringEnabled;
      if (key === "contractAnchoring.required") return anchoringRequired;
      return undefined;
    }),
  };
}

const mockVerificationEventService = {
  recordEvent: jest.fn().mockResolvedValue(undefined),
  getAggregateStats: jest.fn().mockResolvedValue({}),
  cleanupExpiredEvents: jest.fn().mockResolvedValue(0),
} as unknown as VerificationEventService;

const mockAttestationsService = {
  getValidAttestationsForSubject: jest.fn().mockResolvedValue([]),
} as unknown as AttestationsService;

const user = {
  id: "user_1",
  walletAddress: "GB_TEST",
  walletHash: "sha256:wallet",
  role: "WORKER",
};

const config = makeConfig();

const singlePayment = [
  {
    id: "payment_1",
    assetCode: "XLM",
    assetIssuer: null,
    amountEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
    classification: PaymentClassification.INCOME,
    isEligible: true,
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
  },
];

const activeSupportedAsset = {
  id: "asset_1",
  assetKey: "testnet:native:XLM",
  code: "XLM",
  issuer: null,
  network: "testnet",
  status: ResourceStatus.ACTIVE,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function makeCreatePrisma(
  captureIntent?: (data: unknown) => void,
  supportedAsset: unknown = activeSupportedAsset,
) {
  return {
    payment: {
      findMany: jest.fn().mockResolvedValue(singlePayment),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        supportedAsset: {
          findFirst: jest.fn().mockResolvedValue(supportedAsset),
        },
        proof: {
          create: jest.fn().mockImplementation(({ data }) => ({
            id: data.id,
            userId: data.userId,
            proofType: data.proofType,
            schemaVersion: data.schemaVersion,
            status: data.status,
            network: data.network,
            assetCode: data.assetCode,
            assetIssuer: data.assetIssuer,
            assetPolicyId: data.assetPolicyId,
            assetPolicySnapshot: data.assetPolicySnapshot,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            expiresAt: data.expiresAt,
            credentialHash: data.credentialHash,
            commitment: data.commitment,
            createdAt: data.createdAt,
            claim: data.claim.create,
          })),
        },
        anchoringIntent: {
          create: jest.fn().mockImplementation(({ data }) => {
            captureIntent?.(data);
            return { id: "intent_1", ...data };
          }),
        },
      };
      return fn(tx);
    }),
  };
}

describe("ProofsService", () => {
  it("rejects selected payments below the requested threshold", async () => {
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "payment_1",
            assetCode: "XLM",
            assetIssuer: null,
            amountEncrypted: `redacted:${Buffer.from("25").toString("base64url")}`,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ]),
      },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, mockAttestationsService);

    await expect(
      service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      }),
    ).rejects.toThrow("minimum income threshold");
  });

  it("returns an unknown public verification state for missing proofs", async () => {
    (mockVerificationEventService.recordEvent as jest.Mock).mockClear();
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      verificationEventLog: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, mockAttestationsService);

    await expect(service.verifyProof("missing")).resolves.toEqual({
      result: VerificationResult.UNKNOWN_PROOF,
      status: "unknown",
    });
    expect(mockVerificationEventService.recordEvent).not.toHaveBeenCalled();
  });

  it("returns a revoked public verification state", async () => {
    const credential = {
      id: "proof_1",
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: "earnproof.minimum-income.v1",
      issuer: "earnproof-backend",
      subject: { walletHash: "sha256:wallet" },
      claim: {
        operator: "gte",
        thresholdAmount: "100",
        assetCode: "XLM",
        assetIssuer: null,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
        qualifyingPaymentCount: 1,
      },
      privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2027-09-01T00:00:00.000Z",
    };
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          status: ProofStatus.REVOKED,
          network: "testnet",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: new Date("2026-08-31T23:59:59.000Z"),
          expiresAt: new Date("2027-09-01T00:00:00.000Z"),
          revokedAt: new Date("2026-08-03T00:00:00.000Z"),
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
          credentialHash: `sha256:${sha256(canonicalize(credential))}`,
          contractTransactionHash: null,
          user: { walletHash: "sha256:wallet" },
          claim: {
            thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
            disclosurePolicy: { qualifyingPaymentCount: 1 },
          },
        }),
      },
      verificationEvent: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, mockAttestationsService);

    const result = await service.verifyProof("proof_1");

    expect(JSON.stringify(result)).not.toMatch(/memo(Context)?/i);

    expect(result.result).toBe(VerificationResult.REVOKED);
    expect(result.status).toBe("revoked");
  });

  it("revokes anchored proofs by enqueuing REVOKE intent in same transaction", async () => {
    const capturedIntents: unknown[] = [];
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_anchored",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: "tx_register",
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          proof: {
            update: jest.fn().mockResolvedValue({
              id: "proof_anchored",
              status: ProofStatus.REVOKED,
              revokedAt: new Date("2026-08-04T00:00:00.000Z"),
            }),
          },
          anchoringIntent: {
            create: jest.fn().mockImplementation(({ data }) => {
              capturedIntents.push(data);
              return { id: "intent_revoke", ...data };
            }),
          },
        };
        return fn(tx);
      }),
    };
    const service = new ProofsService(
      prisma as never,
      makeConfig(true) as never, // anchoring enabled
      mockVerificationEventService,
      mockAttestationsService,
    );

    const result = await service.revokeProof("user_1", "proof_anchored");

    expect(result.id).toBe("proof_anchored");
    expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    // Revoke intent must have been created inside the transaction.
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0]).toMatchObject({
      proofId: "proof_anchored",
      operation: AnchoringOperation.REVOKE,
      status: AnchoringStatus.PENDING,
    });
  });

  it("uses revoked on-chain status during public verification", async () => {
    const credential = {
      id: "proof_onchain_revoked",
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: "earnproof.minimum-income.v1",
      issuer: "earnproof-backend",
      subject: { walletHash: "sha256:wallet" },
      claim: {
        operator: "gte",
        thresholdAmount: "100",
        assetCode: "XLM",
        assetIssuer: null,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
        qualifyingPaymentCount: 1,
      },
      privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2027-09-01T00:00:00.000Z",
    };
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_onchain_revoked",
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          status: ProofStatus.ACTIVE,
          network: "testnet",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: new Date("2026-08-31T23:59:59.000Z"),
          expiresAt: new Date("2027-09-01T00:00:00.000Z"),
          revokedAt: null,
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
          credentialHash: `sha256:${sha256(canonicalize(credential))}`,
          contractTransactionHash: "tx_register",
          user: { walletHash: "sha256:wallet" },
          claim: {
            thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
            disclosurePolicy: { qualifyingPaymentCount: 1 },
          },
        }),
      },
      verificationEvent: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const anchoring = {
      getProofStatus: jest.fn().mockResolvedValue({
        checked: true,
        revoked: true,
        valid: false,
      }),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
      mockAttestationsService,
      anchoring as never,
    );

    const result = await service.verifyProof("proof_onchain_revoked");

    expect(result.result).toBe(VerificationResult.REVOKED);
    expect(result.status).toBe("revoked");
    expect(result.proof?.contractStatus).toEqual({
      checked: true,
      revoked: true,
      valid: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Outbox / anchoring policy tests
  // ---------------------------------------------------------------------------

  describe("anchoring outbox â€” same-transaction intent creation", () => {
    it("writes REGISTER AnchoringIntent inside the proof creation transaction when anchoring is enabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeCreatePrisma((data) => capturedIntents.push(data));
      const service = new ProofsService(
        prisma as never,
        makeConfig(true) as never, // anchoring enabled
        mockVerificationEventService,
        mockAttestationsService,
      );

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]).toMatchObject({
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      });
    });

    it("does NOT write an AnchoringIntent when anchoring is disabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeCreatePrisma((data) => capturedIntents.push(data));
      const service = new ProofsService(prisma as never, makeConfig(false) as never, mockVerificationEventService, mockAttestationsService);

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedIntents).toHaveLength(0);
    });

    it("returns anchoring: pending when anchoring is enabled (not waiting for CLI)", async () => {
      const prisma = makeCreatePrisma();
      const service = new ProofsService(prisma as never, makeConfig(true) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    });

    it("returns anchoring: disabled when anchoring is not enabled", async () => {
      const prisma = makeCreatePrisma();
      const service = new ProofsService(prisma as never, makeConfig(false) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(result.anchoring).toEqual({ anchored: false, reason: "disabled" });
    });
  });

  describe("required anchoring policy â€” verify endpoint", () => {
    function makeVerifyProof(contractTransactionHash: string | null, credOverrides: Record<string, unknown> = {}) {
      const credential = {
        id: "proof_req",
        type: "EarnProofMinimumIncomeCredential",
        schemaVersion: "earnproof.minimum-income.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "gte",
          thresholdAmount: "100",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2027-09-01T00:00:00.000Z",
        ...credOverrides,
      };
      return {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_req",
            proofType: ProofType.MINIMUM_INCOME,
            schemaVersion: "earnproof.minimum-income.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt: new Date("2027-09-01T00:00:00.000Z"),
            revokedAt: null,
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
              disclosurePolicy: { qualifyingPaymentCount: 1 },
            },
          }),
        },
        verificationEvent: {
          create: jest.fn().mockResolvedValue({ id: "event_1" }),
        },
      };
    }


    it("returns UNVERIFIED_ISSUER when anchoring is required and proof has no contractTransactionHash (anchoring still pending)", async () => {
      const prisma = makeVerifyProof(null); // no tx hash yet
      const service = new ProofsService(prisma as never, makeConfig(true, true) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.UNVERIFIED_ISSUER);
    });

    it("returns VALID when anchoring is required and proof has a contractTransactionHash (anchored)", async () => {
      const prisma = makeVerifyProof("tx_confirmed");
      const service = new ProofsService(prisma as never, makeConfig(true, true) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });

    it("returns VALID (not UNVERIFIED_ISSUER) when anchoring is optional even without contractTransactionHash", async () => {
      const prisma = makeVerifyProof(null);
      // optional: enabled=true, required=false
      const service = new ProofsService(prisma as never, makeConfig(true, false) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });

    it("returns VALID when anchoring is fully disabled even without contractTransactionHash", async () => {
      const prisma = makeVerifyProof(null);
      const service = new ProofsService(prisma as never, makeConfig(false, false) as never, mockVerificationEventService, mockAttestationsService);

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });
  });

  describe("supported-asset policy enforcement at issuance", () => {
    it("persists assetPolicyId and assetPolicySnapshot on the created proof (positive)", async () => {
      const capturedProofData: Record<string, unknown>[] = [];
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: {
                findFirst: jest.fn().mockResolvedValue(activeSupportedAsset),
              },
              proof: {
                create: jest.fn().mockImplementation(({ data }) => {
                  capturedProofData.push(data);
                  return { ...data, claim: data.claim.create };
                }),
              },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedProofData).toHaveLength(1);
      expect(capturedProofData[0]).toMatchObject({
        assetPolicyId: "asset_1",
        assetPolicySnapshot: expect.objectContaining({
          supportedAssetId: "asset_1",
          code: "XLM",
          issuer: null,
          network: "testnet",
          status: ResourceStatus.ACTIVE,
          canonicalAssetId: "testnet:native:XLM",
        }),
      });
    });

    it("rejects issuance and writes no proof when the asset is no longer active (negative)", async () => {
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: {
                // Asset was deactivated between sync and issuance.
                findFirst: jest.fn().mockResolvedValue(null),
              },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createMinimumIncomeProof(user, {
          selectedPaymentIds: ["payment_1"],
          thresholdAmount: "100",
          assetCode: "XLM",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("rejects payment-receipt issuance when the asset is no longer active (negative, second issuance path)", async () => {
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findFirst: jest.fn().mockResolvedValue({
            operationId: "op_1",
            sourceAddress: "GA",
            assetCode: "XLM",
            assetIssuer: null,
            amountEncrypted: `redacted:${Buffer.from("10").toString("base64url")}`,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: new Date("2026-08-01T00:00:00.000Z"),
          }),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createPaymentReceiptProof(user, { paymentId: "payment_1" }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("keeps stale Payment.isEligible from making a deactivated asset newly eligible for a proof (regression, TOCTOU)", async () => {
      // Payment.isEligible is still true (sync has not rerun since deactivation),
      // but the live registry check inside the transaction is authoritative.
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment), // isEligible: true (stale)
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createMinimumIncomeProof(user, {
          selectedPaymentIds: ["payment_1"],
          thresholdAmount: "100",
          assetCode: "XLM",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("handles concurrent issuance attempts: the request racing a mid-flight deactivation is rejected while the other succeeds", async () => {
      // Simulates two overlapping issuance calls against the same asset. The
      // live re-check happens inside each transaction, so whichever call's
      // transaction observes the asset as ACTIVE succeeds, and whichever
      // observes it deactivated (e.g. an admin action lands between the two
      // transactions starting) is rejected - never both accepted, never a
      // silent write for the deactivated one.
      const firstProofCreate = jest.fn().mockImplementation(({ data }) => ({
        ...data,
        claim: data.claim.create,
      }));
      const secondProofCreate = jest.fn();

      const firstPrisma = {
        payment: { findMany: jest.fn().mockResolvedValue(singlePayment) },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) =>
            fn({
              supportedAsset: {
                findFirst: jest.fn().mockResolvedValue(activeSupportedAsset),
              },
              proof: { create: firstProofCreate },
              anchoringIntent: { create: jest.fn() },
            }),
          ),
      };
      const secondPrisma = {
        payment: { findMany: jest.fn().mockResolvedValue(singlePayment) },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) =>
            fn({
              // This concurrent attempt observes the asset as deactivated,
              // e.g. an admin toggled it between the two calls' start and
              // this transaction actually running its live check.
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: secondProofCreate },
              anchoringIntent: { create: jest.fn() },
            }),
          ),
      };

      const serviceOne = new ProofsService(
        firstPrisma as never,
        config as never,
        mockVerificationEventService,
      );
      const serviceTwo = new ProofsService(
        secondPrisma as never,
        config as never,
        mockVerificationEventService,
      );

      const input = {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      };

      const [firstOutcome, secondOutcome] = await Promise.allSettled([
        serviceOne.createMinimumIncomeProof(user, input),
        serviceTwo.createMinimumIncomeProof(user, input),
      ]);

      expect(firstOutcome.status).toBe("fulfilled");
      expect(secondOutcome.status).toBe("rejected");
      if (secondOutcome.status === "rejected") {
        expect(secondOutcome.reason).toMatchObject({
          response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
        });
      }
      expect(firstProofCreate).toHaveBeenCalledTimes(1);
      expect(secondProofCreate).not.toHaveBeenCalled();
    });

    it("never consults the live SupportedAsset registry during verification (regression: historical proofs stay verifiable after deactivation)", async () => {
      const credential = {
        id: "proof_after_deactivation",
        type: "EarnProofMinimumIncomeCredential",
        schemaVersion: "earnproof.minimum-income.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "gte",
          thresholdAmount: "100",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2030-08-20T00:00:00.000Z",
      };
      // Deliberately no `supportedAsset` key on this mock at all: if
      // verifyProof ever tried to consult the live registry, this test would
      // throw with "prisma.supportedAsset is undefined" instead of resolving.
      const prisma = {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_after_deactivation",
            proofType: ProofType.MINIMUM_INCOME,
            schemaVersion: "earnproof.minimum-income.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            // The asset this proof was issued against has since been
            // deactivated in SupportedAsset - but that must not matter here.
            assetPolicyId: "asset_1",
            assetPolicySnapshot: {
              supportedAssetId: "asset_1",
              code: "XLM",
              issuer: null,
              network: "testnet",
              status: ResourceStatus.ACTIVE,
              canonicalAssetId: "testnet:native:XLM",
              checkedAt: "2026-08-02T00:00:00.000Z",
            },
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt: new Date("2030-08-20T00:00:00.000Z"),
            revokedAt: null,
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash: null,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
              disclosurePolicy: { qualifyingPaymentCount: 1 },
            },
          }),
        },
        verificationEvent: {
          create: jest.fn().mockResolvedValue({ id: "event_1" }),
        },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.verifyProof("proof_after_deactivation"),
      ).resolves.toMatchObject({ result: VerificationResult.VALID });
    });
  });
});



