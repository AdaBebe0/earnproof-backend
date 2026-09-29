import {
  AnchoringOperation,
  AnchoringStatus,
  PaymentClassification,
  ProofStatus,
  ProofType,
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

function makeCreatePrisma(captureIntent?: (data: unknown) => void) {
  return {
    payment: {
      findMany: jest.fn().mockResolvedValue(singlePayment),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
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

  // ---------------------------------------------------------------------------
  // createIncomeRangeProof
  // ---------------------------------------------------------------------------

  describe("createIncomeRangeProof", () => {
    function makePayment(overrides: Record<string, unknown> = {}) {
      return {
        id: "payment_1",
        assetCode: "XLM",
        assetIssuer: null,
        amountEncrypted: `redacted:${Buffer.from("1000").toString("base64url")}`,
        classification: PaymentClassification.INCOME,
        isEligible: true,
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        ...overrides,
      };
    }

    const baseInput = {
      selectedPaymentIds: ["payment_1"],
      lowerBound: "500",
      upperBound: "1500",
      assetCode: "XLM",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.000Z",
    };

    function makeIncomeRangePrisma(
      payments: unknown[],
      captureIntent?: (data: unknown) => void,
    ) {
      return {
        payment: {
          findMany: jest.fn().mockResolvedValue(payments),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
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

    // --- positive -----------------------------------------------------------

    it("issues a proof when the payment sum falls inside the requested range", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(result.proofId).toBeDefined();
      expect(result.status).toBe(ProofStatus.ACTIVE);
      expect(result.credential.claim).toMatchObject({
        operator: "range",
        lowerBound: "500",
        upperBound: "1500",
        assetCode: "XLM",
        qualifyingPaymentCount: 1,
      });
      expect(result.credential.type).toBe("EarnProofIncomeRangeCredential");
    });

    it("issues a proof across mixed payments that share the requested asset", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          id: "payment_1",
          amountEncrypted: `redacted:${Buffer.from("300").toString("base64url")}`,
        }),
        makePayment({
          id: "payment_2",
          amountEncrypted: `redacted:${Buffer.from("400").toString("base64url")}`,
          occurredAt: new Date("2026-08-15T00:00:00.000Z"),
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, {
        ...baseInput,
        selectedPaymentIds: ["payment_1", "payment_2"],
      });

      expect(result.credential.claim).toMatchObject({
        qualifyingPaymentCount: 2,
      });
    });

    // --- boundary -------------------------------------------------------------

    it("accepts a sum exactly equal to the lowerBound (inclusive)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("500").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).resolves.toBeDefined();
    });

    it("accepts a sum exactly equal to the upperBound (inclusive)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("1500").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).resolves.toBeDefined();
    });

    it("rejects an inverted range (lowerBound > upperBound)", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          lowerBound: "1500",
          upperBound: "500",
        }),
      ).rejects.toThrow("lowerBound must be strictly less than upperBound");
    });

    it("rejects a degenerate zero-width range (lowerBound === upperBound)", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          lowerBound: "1000",
          upperBound: "1000",
        }),
      ).rejects.toThrow("lowerBound must be strictly less than upperBound");
    });

    // --- negative ---------------------------------------------------------

    it("rejects when the payment sum is below the lowerBound", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("do not fall within the requested income range");
    });

    it("rejects when the payment sum is above the upperBound", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("2000").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("do not fall within the requested income range");
    });

    it("rejects a payment using a different asset than requested", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ assetCode: "USDC" }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must use the requested asset");
    });

    it("rejects mixed-asset selected payments (regression)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ id: "payment_1", assetCode: "XLM" }),
        makePayment({ id: "payment_2", assetCode: "USDC" }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          selectedPaymentIds: ["payment_1", "payment_2"],
        }),
      ).rejects.toThrow("must use the requested asset");
    });

    it("rejects a payment belonging to another user (ownership check)", async () => {
      // findMany scoped to userId returns fewer rows than requested when a
      // payment id does not resolve for this user.
      const prisma = makeIncomeRangePrisma([]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("One or more selected payments are invalid");
    });

    it("rejects a non-INCOME classified payment", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ classification: PaymentClassification.EXCLUDED }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must be eligible income payments");
    });

    it("rejects an ineligible payment", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ isEligible: false }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must be eligible income payments");
    });

    it("rejects a payment that occurred outside the requested period", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ occurredAt: new Date("2026-09-15T00:00:00.000Z") }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must fall inside the requested period");
    });

    it("rejects when periodStart is after periodEnd", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          periodStart: "2026-08-31T23:59:59.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
        }),
      ).rejects.toThrow("periodStart must be before periodEnd");
    });

    // --- privacy regression -------------------------------------------------

    it("never leaks the summed total into the disclosure policy or credential", async () => {
      const capturedClaims: unknown[] = [];
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue([
            makePayment({
              amountEncrypted: `redacted:${Buffer.from("777").toString("base64url")}`,
            }),
          ]),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              proof: {
                create: jest.fn().mockImplementation(({ data }) => {
                  capturedClaims.push(data.claim.create);
                  return {
                    id: data.id,
                    userId: data.userId,
                    proofType: data.proofType,
                    schemaVersion: data.schemaVersion,
                    status: data.status,
                    network: data.network,
                    assetCode: data.assetCode,
                    assetIssuer: data.assetIssuer,
                    periodStart: data.periodStart,
                    periodEnd: data.periodEnd,
                    expiresAt: data.expiresAt,
                    credentialHash: data.credentialHash,
                    commitment: data.commitment,
                    createdAt: data.createdAt,
                    claim: data.claim.create,
                  };
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

      const result = await service.createIncomeRangeProof(user, baseInput);

      const serializedClaim = JSON.stringify(capturedClaims[0]);
      const serializedCredential = JSON.stringify(result.credential);

      // The sum (777) must never appear anywhere in persisted or emitted data.
      expect(serializedClaim).not.toContain("777");
      expect(serializedCredential).not.toContain("777");
      expect(capturedClaims[0]).toMatchObject({
        operator: "range",
        disclosurePolicy: {
          exactIncomeHidden: true,
          sourceTransactionsHidden: true,
          qualifyingPaymentCount: 1,
          lowerBound: "500",
          upperBound: "1500",
        },
      });
    });

    // --- anchoring parity with createMinimumIncomeProof ---------------------

    it("enqueues a REGISTER anchoring intent identically to createMinimumIncomeProof when anchoring is enabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeIncomeRangePrisma([makePayment()], (data) =>
        capturedIntents.push(data),
      );
      const service = new ProofsService(
        prisma as never,
        makeConfig(true) as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]).toMatchObject({
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      });
      expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    });

    it("does not enqueue an anchoring intent when anchoring is disabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeIncomeRangePrisma([makePayment()], (data) =>
        capturedIntents.push(data),
      );
      const service = new ProofsService(
        prisma as never,
        makeConfig(false) as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(capturedIntents).toHaveLength(0);
      expect(result.anchoring).toEqual({
        anchored: false,
        reason: "disabled",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // verifyProof — INCOME_RANGE
  // ---------------------------------------------------------------------------

  describe("verifyProof — income range", () => {
    it("rebuilds and verifies an INCOME_RANGE credential without leaking the sum", async () => {
      const credential = {
        id: "proof_range",
        type: "EarnProofIncomeRangeCredential",
        schemaVersion: "earnproof.income-range.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "range",
          lowerBound: "500",
          upperBound: "1500",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      };
      const prisma = {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_range",
            userId: "user_1",
            proofType: ProofType.INCOME_RANGE,
            schemaVersion: "earnproof.income-range.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt: new Date("2026-10-01T00:00:00.000Z"),
            revokedAt: null,
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash: null,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: null,
              frequency: null,
              disclosurePolicy: {
                qualifyingPaymentCount: 1,
                lowerBound: "500",
                upperBound: "1500",
              },
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

      const result = await service.verifyProof("proof_range");

      expect(result.result).toBe(VerificationResult.VALID);
      expect(result.status).toBe("valid");
      expect(result.credential?.claim).toMatchObject({
        operator: "range",
        lowerBound: "500",
        upperBound: "1500",
      });
    });
  });
});



