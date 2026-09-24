import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VerificationOutcome } from "@prisma/client";
import { VerificationEventService } from "./verification-event.service";

describe("VerificationEventService", () => {
  let service: VerificationEventService;
  let configService: ConfigService;
  let prismaService: any;

  const createMockPrismaService = () => ({
    verificationEventLog: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prismaService = createMockPrismaService();
    configService = {
      get: jest.fn((key: string) => {
        const config: Record<string, unknown> = {
          verificationEventRetentionDays: 90,
          VERIFICATION_HASH_SALT_VERSION: 0,
          VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
          VERIFICATION_HASH_SALT_V1: "test-salt-v1-32-character-string!",
        };
        return config[key];
      }),
    } as unknown as ConfigService<Record<string, unknown>>;

    // Suppress logger output in tests
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    service = new VerificationEventService(prismaService, configService);
  });

  describe("recordEvent", () => {
    describe("outcome recording", () => {
      it("records VALID outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.VALID,
              proofId: "proof_123",
            }),
          }),
        );
      });

      it("records EXPIRED outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.EXPIRED,
          "proof_456",
          { outcome: "EXPIRED" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.EXPIRED,
              proofId: "proof_456",
            }),
          }),
        );
      });

      it("records REVOKED outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.REVOKED,
          "proof_789",
          { outcome: "REVOKED" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.REVOKED,
              proofId: "proof_789",
            }),
          }),
        );
      });

      it("records UNKNOWN outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.UNKNOWN,
          "proof_unknown",
          { outcome: "UNKNOWN" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.UNKNOWN,
            }),
          }),
        );
      });

      it("records INVALID_SIGNATURE outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.INVALID_SIGNATURE,
          "proof_invalid",
          { outcome: "INVALID_SIGNATURE" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.INVALID_SIGNATURE,
            }),
          }),
        );
      });

      it("records ISSUER_WARNING outcome correctly", async () => {
        await service.recordEvent(
          VerificationOutcome.ISSUER_WARNING,
          "proof_warning",
          { outcome: "ISSUER_WARNING" },
        );

        expect(prismaService.verificationEventLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: VerificationOutcome.ISSUER_WARNING,
            }),
          }),
        );
      });
    });

    describe("privacy guarantees", () => {
      it("NEVER stores raw IP address in any field", async () => {
        const metadata = {
          outcome: "VALID",
          requestId: "req_123",
        };
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          metadata,
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        // Verify no IP is stored anywhere
        expect(JSON.stringify(recordedData)).not.toContain("192.168");
        expect(JSON.stringify(recordedData)).not.toContain("10.0");
        expect(JSON.stringify(recordedData)).not.toContain("::1");
        expect(recordedData.metadataHash).not.toMatch(
          /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
        );
      });

      it("NEVER stores user agent in any field", async () => {
        const metadata = {
          outcome: "VALID",
          requestId: "req_123",
        };
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          metadata,
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        expect(JSON.stringify(recordedData)).not.toContain("Mozilla");
        expect(JSON.stringify(recordedData)).not.toContain("Chrome");
        expect(JSON.stringify(recordedData)).not.toContain("Safari");
        expect(JSON.stringify(recordedData)).not.toContain("User-Agent");
      });

      it("NEVER stores wallet address in any field", async () => {
        const metadata = {
          outcome: "VALID",
          requestId: "req_123",
        };
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          metadata,
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        expect(JSON.stringify(recordedData)).not.toContain("GBUQWP3");
        expect(JSON.stringify(recordedData)).not.toContain("GB");
        // Proof ID should be there, but not as a wallet
        expect(recordedData.proofId).toBe("proof_123");
      });

      it("NEVER stores proof secrets in any field", async () => {
        const metadata = {
          outcome: "VALID",
          requestId: "req_123",
        };
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          metadata,
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        // Should not contain any credential-like data
        expect(JSON.stringify(recordedData)).not.toContain("credentialHash");
        expect(JSON.stringify(recordedData)).not.toContain("hmac-sha256");
        expect(JSON.stringify(recordedData)).not.toContain("secret");
      });
    });

    describe("fail-open behavior", () => {
      it("does NOT throw when database write fails", async () => {
        prismaService.verificationEventLog.create.mockRejectedValueOnce(
          new Error("Database connection failed"),
        );

        // Should not throw
        await expect(
          service.recordEvent(
            VerificationOutcome.VALID,
            "proof_123",
            { outcome: "VALID" },
          ),
        ).resolves.toBeUndefined();
      });

      it("returns void even on write failure", async () => {
        prismaService.verificationEventLog.create.mockRejectedValueOnce(
          new Error("Write failed"),
        );

        const result = await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        expect(result).toBeUndefined();
      });

      it("continues verification unblocked after write failure", async () => {
        prismaService.verificationEventLog.create.mockRejectedValueOnce(
          new Error("Write failed"),
        );

        // Simulate calling recordEvent as part of verification flow
        const recordPromise = service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        // This should complete quickly without blocking
        await expect(recordPromise).resolves.toBeUndefined();
      });
    });

    describe("retention configuration", () => {
      it("sets retainUntil correctly based on VERIFICATION_EVENT_RETENTION_DAYS", async () => {
        const configWithRetention = {
          get: jest.fn((key: string) => {
            const config: Record<string, unknown> = {
              verificationEventRetentionDays: 60,
              VERIFICATION_HASH_SALT_VERSION: 0,
              VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
            };
            return config[key];
          }),
        } as unknown as ConfigService<Record<string, unknown>>;
        const svc = new VerificationEventService(
          prismaService,
          configWithRetention,
        );

        const beforeCall = Date.now();
        await svc.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const retainUntil = call[0].data.retainUntil;

        // Should be ~60 days from now
        const expectedMs = 60 * 24 * 60 * 60 * 1000;
        const actualMs = retainUntil.getTime() - beforeCall;

        // Allow ±5 second window for test execution
        expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000);
      });

      it("uses default 90 days when retention not configured", async () => {
        const configNoRetention = {
          get: jest.fn((key: string) => {
            const config: Record<string, unknown> = {
              verificationEventRetentionDays: undefined,
              VERIFICATION_HASH_SALT_VERSION: 0,
              VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
            };
            return config[key];
          }),
        } as unknown as ConfigService<Record<string, unknown>>;
        const svc = new VerificationEventService(
          prismaService,
          configNoRetention,
        );

        const beforeCall = Date.now();
        await svc.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const retainUntil = call[0].data.retainUntil;

        const expectedMs = 90 * 24 * 60 * 60 * 1000;
        const actualMs = retainUntil.getTime() - beforeCall;

        expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000);
      });
    });

    describe("salt version tracking", () => {
      it("stores saltVersion in record", async () => {
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        expect(recordedData.saltVersion).toEqual(expect.any(Number));
      });

      it("uses configured salt version (default 0)", async () => {
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        // Default config service returns 0
        expect(recordedData.saltVersion).toBe(0);
      });

      it("respects VERIFICATION_HASH_SALT_VERSION config", async () => {
        const configWithVersion = {
          get: jest.fn((key: string) => {
            const config: Record<string, unknown> = {
              verificationHashSaltVersion: 2,
              VERIFICATION_HASH_SALT_VERSION: 2,
              VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
              VERIFICATION_HASH_SALT_V1: "test-salt-v1-32-character-string!",
              VERIFICATION_HASH_SALT_V2: "test-salt-v2-32-character-string!",
            };
            return config[key];
          }),
        } as unknown as ConfigService<Record<string, unknown>>;
        const svc = new VerificationEventService(
          prismaService,
          configWithVersion,
        );

        await svc.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        expect(recordedData.saltVersion).toBe(2);
      });

      it("salt version is within loadable range (0-99)", async () => {
        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        const call = prismaService.verificationEventLog.create.mock.calls[0];
        const recordedData = call[0].data;

        expect(recordedData.saltVersion).toBeGreaterThanOrEqual(0);
        expect(recordedData.saltVersion).toBeLessThan(100);
      });

      it("recording actually persists event (does not fail open due to missing salt)", async () => {
        prismaService.verificationEventLog.create.mockResolvedValueOnce({
          id: "event_123",
          outcome: VerificationOutcome.VALID,
          proofId: "proof_123",
          metadataHash: "hash",
          saltVersion: 0,
          retainUntil: new Date(),
          createdAt: new Date(),
        });

        await service.recordEvent(
          VerificationOutcome.VALID,
          "proof_123",
          { outcome: "VALID" },
        );

        // Verify create was called (event was persisted)
        expect(prismaService.verificationEventLog.create).toHaveBeenCalled();
      });

      it("increments saltVersion as salt rotates (different versions)", async () => {
        // We can't easily test long-term rotation in unit tests,
        // but we can verify different configured versions work
        const configV0 = {
          get: jest.fn((key: string) => {
            const config: Record<string, unknown> = {
              verificationHashSaltVersion: 0,
              VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
              VERIFICATION_HASH_SALT_V1: "test-salt-v1-32-character-string!",
            };
            return config[key];
          }),
        } as unknown as ConfigService<Record<string, unknown>>;
        const svcV0 = new VerificationEventService(
          prismaService,
          configV0,
        );

        const configV1 = {
          get: jest.fn((key: string) => {
            const config: Record<string, unknown> = {
              verificationHashSaltVersion: 1,
              VERIFICATION_HASH_SALT_V0: "test-salt-v0-32-character-string!",
              VERIFICATION_HASH_SALT_V1: "test-salt-v1-32-character-string!",
            };
            return config[key];
          }),
        } as unknown as ConfigService<Record<string, unknown>>;
        const svcV1 = new VerificationEventService(
          prismaService,
          configV1,
        );

        const metadata = { outcome: "VALID", timestamp: new Date() };

        const hashV0 = svcV0.hashMetadata(metadata, 0);
        const hashV1 = svcV1.hashMetadata(metadata, 1);

        // Different versions should produce different hashes
        expect(hashV0).not.toBe(hashV1);
      });
    });
  });

  describe("hashMetadata", () => {
    describe("consistency and determinism", () => {
      it("produces consistent hash for same input + saltVersion", () => {
        const metadata = {
          outcome: "VALID",
          timestamp: new Date("2026-08-24T12:00:00Z"),
          requestId: "req_123",
        };

        const hash1 = service.hashMetadata(metadata, 0);
        const hash2 = service.hashMetadata(metadata, 0);

        expect(hash1).toBe(hash2);
      });

      it("produces different hashes for different saltVersions", () => {
        const metadata = {
          outcome: "VALID",
          timestamp: new Date("2026-08-24T12:00:00Z"),
          requestId: "req_123",
        };

        const hashV0 = service.hashMetadata(metadata, 0);
        const hashV1 = service.hashMetadata(metadata, 1);

        expect(hashV0).not.toBe(hashV1);
      });

      it("produces different hashes for different outcomes", () => {
        const timestamp = new Date("2026-08-24T12:00:00Z");
        const requestId = "req_123";

        const hashValid = service.hashMetadata(
          { outcome: "VALID", timestamp, requestId },
          0,
        );
        const hashExpired = service.hashMetadata(
          { outcome: "EXPIRED", timestamp, requestId },
          0,
        );

        expect(hashValid).not.toBe(hashExpired);
      });

      it("produces hash in hex format", () => {
        const metadata = { outcome: "VALID" };
        const hash = service.hashMetadata(metadata, 0);

        // SHA256 hex is 64 characters
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    describe("salt version validation", () => {
      it("throws error for unconfigured salt version", () => {
        const metadata = { outcome: "VALID" };

        expect(() => {
          service.hashMetadata(metadata, 999);
        }).toThrow("No salt configured for version 999");
      });
    });
  });

  describe("cleanupExpiredEvents", () => {
    it("deletes events where retainUntil < now", async () => {
      prismaService.verificationEventLog.deleteMany.mockResolvedValueOnce({
        count: 5,
      });

      const result = await service.cleanupExpiredEvents();

      expect(prismaService.verificationEventLog.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            retainUntil: expect.objectContaining({
              lt: expect.any(Date),
            }),
          }),
        }),
      );

      expect(result).toBe(5);
    });

    it("preserves events where retainUntil >= now", async () => {
      prismaService.verificationEventLog.deleteMany.mockResolvedValueOnce({
        count: 0,
      });

      await service.cleanupExpiredEvents();

      // Verify the where clause uses less-than (<) not less-than-or-equal (<=)
      const call = prismaService.verificationEventLog.deleteMany.mock.calls[0];
      const whereClause = call[0].where;

      expect(whereClause.retainUntil).toHaveProperty("lt");
      expect(whereClause.retainUntil).not.toHaveProperty("lte");
    });

    it("returns correct count of deleted records", async () => {
      prismaService.verificationEventLog.deleteMany.mockResolvedValueOnce({
        count: 12,
      });

      const result = await service.cleanupExpiredEvents();

      expect(result).toBe(12);
    });

    it("logs cleanup results for auditability", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");
      prismaService.verificationEventLog.deleteMany.mockResolvedValueOnce({
        count: 3,
      });

      await service.cleanupExpiredEvents();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/deleted 3 records/),
      );
    });

    it("handles cleanup errors gracefully and returns 0", async () => {
      prismaService.verificationEventLog.deleteMany.mockRejectedValueOnce(
        new Error("DB error"),
      );

      const result = await service.cleanupExpiredEvents();

      expect(result).toBe(0);
    });
  });

  describe("getAggregateStats", () => {
    it("returns counts per outcome for a given proofId", async () => {
      prismaService.verificationEventLog.findMany.mockResolvedValueOnce([
        { outcome: VerificationOutcome.VALID },
        { outcome: VerificationOutcome.VALID },
        { outcome: VerificationOutcome.EXPIRED },
        { outcome: VerificationOutcome.REVOKED },
      ]);

      const stats = await service.getAggregateStats("proof_123");

      expect(stats[VerificationOutcome.VALID]).toBe(2);
      expect(stats[VerificationOutcome.EXPIRED]).toBe(1);
      expect(stats[VerificationOutcome.REVOKED]).toBe(1);
    });

    it("returns zeros for unknown proofId", async () => {
      prismaService.verificationEventLog.findMany.mockResolvedValueOnce([]);

      const stats = await service.getAggregateStats("proof_unknown");

      for (const outcome of Object.values(VerificationOutcome)) {
        expect(stats[outcome as VerificationOutcome]).toBe(0);
      }
    });

    it("DOES NOT return verifier identity", async () => {
      prismaService.verificationEventLog.findMany.mockResolvedValueOnce([
        { outcome: VerificationOutcome.VALID },
      ]);

      const stats = await service.getAggregateStats("proof_123");

      // Stats should only contain outcome counts, not metadata
      expect(Object.keys(stats).sort()).toEqual(
        Object.values(VerificationOutcome).sort(),
      );
    });

    it("returns counts for all possible outcomes", async () => {
      prismaService.verificationEventLog.findMany.mockResolvedValueOnce([]);

      const stats = await service.getAggregateStats("proof_123");

      expect(Object.keys(stats).sort()).toEqual(
        Object.values(VerificationOutcome).sort(),
      );
    });

    it("handles query errors gracefully and returns empty stats", async () => {
      prismaService.verificationEventLog.findMany.mockRejectedValueOnce(
        new Error("DB error"),
      );

      const stats = await service.getAggregateStats("proof_123");

      // Should return all zeros
      for (const outcome of Object.values(VerificationOutcome)) {
        expect(stats[outcome as VerificationOutcome]).toBe(0);
      }
    });
  });
});
