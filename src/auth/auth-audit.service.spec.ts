import { AuthEventType } from "@prisma/client";
import { AuthAuditService } from "./auth-audit.service";

describe("AuthAuditService", () => {
  const walletAddress = "GABC123...";
  const clientMetadata = "Mozilla/5.0 (X11; Linux x86_64)";

  function makePrismaMock() {
    return {
      authAuditEvent: {
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  describe("recordEvent", () => {
    it("creates an audit event with hashed identifiers", async () => {
      const prisma = makePrismaMock();
      const service = new AuthAuditService(prisma as never);

      await service.recordEvent(AuthEventType.CHALLENGE_CREATED, walletAddress, {
        challengeId: "challenge_123",
        success: true,
        clientMetadata,
      });

      expect(prisma.authAuditEvent.create).toHaveBeenCalledWith({
        data: {
          eventType: AuthEventType.CHALLENGE_CREATED,
          walletHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          clientMetadataHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          challengeId: "challenge_123",
          success: true,
          failureReason: undefined,
          createdAt: expect.any(Date),
        },
      });
    });

    it("records event without client metadata", async () => {
      const prisma = makePrismaMock();
      const service = new AuthAuditService(prisma as never);

      await service.recordEvent(AuthEventType.CHALLENGE_VERIFIED, walletAddress, {
        success: true,
      });

      expect(prisma.authAuditEvent.create).toHaveBeenCalledWith({
        data: {
          eventType: AuthEventType.CHALLENGE_VERIFIED,
          walletHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          clientMetadataHash: undefined,
          challengeId: undefined,
          success: true,
          failureReason: undefined,
          createdAt: expect.any(Date),
        },
      });
    });

    it("records failure reason for unsuccessful events", async () => {
      const prisma = makePrismaMock();
      const service = new AuthAuditService(prisma as never);

      await service.recordEvent(AuthEventType.SIGNATURE_INVALID, walletAddress, {
        challengeId: "challenge_456",
        success: false,
        failureReason: "Invalid signature format",
      });

      expect(prisma.authAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            failureReason: "Invalid signature format",
          }),
        }),
      );
    });

    it("fails open when database write fails", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.create.mockRejectedValue(
        new Error("Database connection lost"),
      );
      const service = new AuthAuditService(prisma as never);

      // Should not throw
      await expect(
        service.recordEvent(AuthEventType.CHALLENGE_CREATED, walletAddress, {
          success: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("getEventCount", () => {
    it("returns count of events within time window", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.count.mockResolvedValue(3);
      const service = new AuthAuditService(prisma as never);

      const count = await service.getEventCount(
        walletAddress,
        AuthEventType.CHALLENGE_CREATED,
        15 * 60 * 1000, // 15 minutes
      );

      expect(count).toBe(3);
      expect(prisma.authAuditEvent.count).toHaveBeenCalledWith({
        where: {
          walletHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          eventType: AuthEventType.CHALLENGE_CREATED,
          createdAt: {
            gte: expect.any(Date),
          },
        },
      });
    });

    it("returns 0 when count query fails", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.count.mockRejectedValue(new Error("Query timeout"));
      const service = new AuthAuditService(prisma as never);

      const count = await service.getEventCount(
        walletAddress,
        AuthEventType.CHALLENGE_CREATED,
        15 * 60 * 1000,
      );

      expect(count).toBe(0);
    });
  });

  describe("getClientEventCount", () => {
    it("returns count of events for client metadata within time window", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.count.mockResolvedValue(2);
      const service = new AuthAuditService(prisma as never);

      const count = await service.getClientEventCount(
        clientMetadata,
        AuthEventType.CHALLENGE_VERIFIED,
        15 * 60 * 1000,
      );

      expect(count).toBe(2);
      expect(prisma.authAuditEvent.count).toHaveBeenCalledWith({
        where: {
          clientMetadataHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          eventType: AuthEventType.CHALLENGE_VERIFIED,
          createdAt: {
            gte: expect.any(Date),
          },
        },
      });
    });
  });

  describe("cleanupOldEvents", () => {
    it("deletes events older than retention period", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.deleteMany.mockResolvedValue({ count: 150 });
      const service = new AuthAuditService(prisma as never);

      const deleted = await service.cleanupOldEvents(90);

      expect(deleted).toBe(150);
      expect(prisma.authAuditEvent.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
    });

    it("returns 0 when cleanup fails", async () => {
      const prisma = makePrismaMock();
      prisma.authAuditEvent.deleteMany.mockRejectedValue(
        new Error("Permission denied"),
      );
      const service = new AuthAuditService(prisma as never);

      const deleted = await service.cleanupOldEvents(90);

      expect(deleted).toBe(0);
    });
  });

  describe("privacy guarantees", () => {
    it("produces deterministic hashes for same input", async () => {
      const prisma = makePrismaMock();
      const service = new AuthAuditService(prisma as never);

      await service.recordEvent(AuthEventType.CHALLENGE_CREATED, walletAddress, {
        success: true,
      });
      const firstCall = prisma.authAuditEvent.create.mock.calls[0][0];

      await service.recordEvent(AuthEventType.CHALLENGE_CREATED, walletAddress, {
        success: true,
      });
      const secondCall = prisma.authAuditEvent.create.mock.calls[1][0];

      expect(firstCall.data.walletHash).toBe(secondCall.data.walletHash);
    });

    it("produces different hashes for different wallet addresses", async () => {
      const prisma = makePrismaMock();
      const service = new AuthAuditService(prisma as never);

      await service.recordEvent(
        AuthEventType.CHALLENGE_CREATED,
        "GABC123...",
        { success: true },
      );
      const firstCall = prisma.authAuditEvent.create.mock.calls[0][0];

      await service.recordEvent(
        AuthEventType.CHALLENGE_CREATED,
        "GXYZ789...",
        { success: true },
      );
      const secondCall = prisma.authAuditEvent.create.mock.calls[1][0];

      expect(firstCall.data.walletHash).not.toBe(secondCall.data.walletHash);
    });
  });
});
