import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthEventType } from "@prisma/client";
import { AuthRateLimiterService } from "./auth-rate-limiter.service";

describe("AuthRateLimiterService", () => {
  const walletAddress = "GABC123...";
  const clientMetadata = "Mozilla/5.0 (X11; Linux x86_64)";

  function makeAuditServiceMock() {
    return {
      getEventCount: jest.fn().mockResolvedValue(0),
      getClientEventCount: jest.fn().mockResolvedValue(0),
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
  }

  const config = {
    get: (key: string) => {
      const defaults: Record<string, number> = {
        "auth.rateLimits.maxChallengeCreations": 10,
        "auth.rateLimits.challengeCreationWindowMs": 900000,
        "auth.rateLimits.maxVerifications": 5,
        "auth.rateLimits.verificationWindowMs": 900000,
      };
      return defaults[key];
    },
  } as ConfigService;

  describe("checkChallengeCreationLimit", () => {
    it("allows challenge creation when under limit", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(3);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress),
      ).resolves.toBeUndefined();
    });

    it("blocks challenge creation when wallet limit exceeded", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(10);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress),
      ).rejects.toThrow("Too many challenge requests");
    });

    it("records rate limit event when blocked", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(10);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress, clientMetadata),
      ).rejects.toThrow();

      expect(auditService.recordEvent).toHaveBeenCalledWith(
        AuthEventType.RATE_LIMITED,
        walletAddress,
        {
          success: false,
          failureReason: "Challenge creation rate limit exceeded",
          clientMetadata,
        },
      );
    });

    it("includes retryAfter in exception", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(15);
      const service = new AuthRateLimiterService(auditService as never, config);

      try {
        await service.checkChallengeCreationLimit(walletAddress);
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as any).response.retryAfter).toBe(900); // 15 minutes in seconds
      }
    });

    it("checks client metadata limit when provided", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(3);
      auditService.getClientEventCount.mockResolvedValue(10);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress, clientMetadata),
      ).rejects.toThrow("Too many challenge requests");

      expect(auditService.getClientEventCount).toHaveBeenCalledWith(
        clientMetadata,
        AuthEventType.CHALLENGE_CREATED,
        900000,
      );
    });

    it("fails open when audit service throws", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockRejectedValue(new Error("Database error"));
      const service = new AuthRateLimiterService(auditService as never, config);

      // Should not throw - fails open
      await expect(
        service.checkChallengeCreationLimit(walletAddress),
      ).resolves.toBeUndefined();
    });
  });

  describe("checkVerificationLimit", () => {
    it("allows verification when under limit", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(2);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkVerificationLimit(walletAddress),
      ).resolves.toBeUndefined();
    });

    it("blocks verification when wallet limit exceeded", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(5);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkVerificationLimit(walletAddress),
      ).rejects.toThrow("Too many verification attempts");
    });

    it("records rate limit event when verification blocked", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(6);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkVerificationLimit(walletAddress, clientMetadata),
      ).rejects.toThrow();

      expect(auditService.recordEvent).toHaveBeenCalledWith(
        AuthEventType.RATE_LIMITED,
        walletAddress,
        {
          success: false,
          failureReason: "Verification rate limit exceeded",
          clientMetadata,
        },
      );
    });

    it("checks client metadata limit for verification", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(2);
      auditService.getClientEventCount.mockResolvedValue(5);
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkVerificationLimit(walletAddress, clientMetadata),
      ).rejects.toThrow("Too many verification attempts");
    });

    it("fails open when audit check fails", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockRejectedValue(new Error("Network timeout"));
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkVerificationLimit(walletAddress),
      ).resolves.toBeUndefined();
    });
  });

  describe("getConfig", () => {
    it("returns current configuration", () => {
      const auditService = makeAuditServiceMock();
      const service = new AuthRateLimiterService(auditService as never, config);

      const configuration = service.getConfig();

      expect(configuration).toEqual({
        maxChallengeCreations: 10,
        challengeCreationWindowMs: 900000,
        maxVerifications: 5,
        verificationWindowMs: 900000,
      });
    });
  });

  describe("boundary conditions", () => {
    it("blocks exactly at limit threshold", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(10); // Exactly at max
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress),
      ).rejects.toThrow("Too many challenge requests");
    });

    it("allows one below limit threshold", async () => {
      const auditService = makeAuditServiceMock();
      auditService.getEventCount.mockResolvedValue(9); // One below max
      const service = new AuthRateLimiterService(auditService as never, config);

      await expect(
        service.checkChallengeCreationLimit(walletAddress),
      ).resolves.toBeUndefined();
    });
  });
});
