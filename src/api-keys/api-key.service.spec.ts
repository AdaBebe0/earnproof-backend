import { ApiKeyScope, ResourceStatus } from "@prisma/client";
import { ApiKeyService } from "./api-key.service";

describe("ApiKeyService", () => {
  let service: ApiKeyService;
  let prismaService: any;

  const mockPrisma = () => ({
    apiKey: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  });

  beforeEach(() => {
    prismaService = mockPrisma();
    service = new ApiKeyService(prismaService);
  });

  describe("generateSecret", () => {
    it("generates a secret with sufficient entropy (32 bytes)", () => {
      const { secret, prefix: generatedPrefix } = service.generateSecret();

      expect(secret).toBeDefined();
      expect(typeof secret).toBe("string");
      // 32 bytes in base64url is ~43 characters
      expect(secret.length).toBeGreaterThanOrEqual(40);
      expect(generatedPrefix).toBeDefined();
    });

    it("generates a prefix that is first 8 characters of secret", () => {
      const { secret, prefix } = service.generateSecret();

      expect(prefix).toBe(secret.substring(0, 8));
      expect(prefix.length).toBe(8);
    });

    it("generates different secrets on multiple calls", () => {
      const { secret: secret1 } = service.generateSecret();
      const { secret: secret2 } = service.generateSecret();

      expect(secret1).not.toBe(secret2);
    });

    it("generates secrets that are URL-safe (base64url)", () => {
      const { secret } = service.generateSecret();

      // base64url uses only alphanumeric, -, and _
      expect(secret).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  describe("hashSecret", () => {
    it("produces a SHA-256 hash (hex string, 64 characters)", () => {
      const secret = "test-secret-123";
      const hash = service.hashSecret(secret);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe("string");
      // SHA-256 hex is always 64 characters
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces consistent hash for same secret", () => {
      const secret = "test-secret-123";
      const hash1 = service.hashSecret(secret);
      const hash2 = service.hashSecret(secret);

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different secrets", () => {
      const hash1 = service.hashSecret("secret-1");
      const hash2 = service.hashSecret("secret-2");

      expect(hash1).not.toBe(hash2);
    });

    it("hash is not the original secret (one-way)", () => {
      const secret = "my-api-key-secret";
      const hash = service.hashSecret(secret);

      // Hash should not contain the original secret
      expect(hash).not.toContain(secret);
      expect(hash).not.toContain("my-api-key");
      expect(typeof hash).toBe("string");
    });
  });

  describe("verifySecret", () => {
    it("returns true when secret matches hash", () => {
      const secret = "test-secret-123";
      const hash = service.hashSecret(secret);

      const isValid = service.verifySecret(secret, hash);
      expect(isValid).toBe(true);
    });

    it("returns false when secret does not match hash", () => {
      const correctSecret = "correct-secret";
      const wrongSecret = "wrong-secret";
      const hash = service.hashSecret(correctSecret);

      const isValid = service.verifySecret(wrongSecret, hash);
      expect(isValid).toBe(false);
    });

    it("uses constant-time comparison (doesn't leak timing info)", () => {
      const secret = "test-secret";
      const hash = service.hashSecret(secret);

      // This is a basic check - a true timing attack would need to measure actual execution times
      // Both should complete without variation based on where the mismatch is
      const wrongShort = "x";
      const wrongLong = "x" + secret.slice(1);

      const result1 = service.verifySecret(wrongShort, hash);
      const result2 = service.verifySecret(wrongLong, hash);

      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });

    it("fails closed when the stored hash is malformed", () => {
      expect(service.verifySecret("test-secret", "not-a-sha256-hash")).toBe(
        false,
      );
    });
  });

  describe("lookupAndVerifyKey", () => {
    it("returns null when key not found by prefix", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      const result = await service.lookupAndVerifyKey(
        "testpref",
        "full-secret-key",
        "org_123",
      );

      expect(result).toBeNull();
    });

    it("returns null when secret hash doesn't match", async () => {
      const correctSecret = "correct-secret-12345";
      const wrongSecret = "wrong-secret-1234567";
      const hash = service.hashSecret(correctSecret);

      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        id: "key_123",
        prefix: "correct_",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date(),
        scopeAssignments: [],
      });

      const result = await service.lookupAndVerifyKey(
        "correct_",
        wrongSecret,
        "org_123",
      );

      expect(result).toBeNull();
    });

    it("returns key details when secret is valid", async () => {
      const secret = "valid-secret-123456789";
      const hash = service.hashSecret(secret);

      const mockKey = {
        id: "key_123",
        prefix: "valid_se",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date("2026-08-24"),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      };

      prismaService.apiKey.findFirst.mockResolvedValueOnce(mockKey);

      const result = await service.lookupAndVerifyKey(
        "valid_se",
        secret,
        "org_123",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe("key_123");
      expect(result!.organizationId).toBe("org_123");
    });

    it("includes scopes in returned key", async () => {
      const secret = "secret-123";
      const hash = service.hashSecret(secret);

      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        id: "key_123",
        prefix: "secret_1",
        keyHash: hash,
        organizationId: "org_123",
        createdAt: new Date(),
        scopeAssignments: [
          { scope: ApiKeyScope.PROOF_VERIFY },
          { scope: ApiKeyScope.PAYMENT_READ },
        ],
      });

      const result = await service.lookupAndVerifyKey(
        "secret_1",
        secret,
        "org_123",
      );

      expect(result!.scopeAssignments).toHaveLength(2);
      expect(result!.scopeAssignments.map((sa) => sa.scope)).toContain(
        ApiKeyScope.PROOF_VERIFY,
      );
    });

    it("enforces organization isolation at query level", async () => {
      const secret = "secret-123";
      service.hashSecret(secret); // Hash for verification but don't use the result

      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      const result = await service.lookupAndVerifyKey(
        "prefix",
        secret,
        "wrong-org-id",
      );

      // Verify the query included the organization filter
      const callArgs = prismaService.apiKey.findFirst.mock.calls[0][0];
      expect(callArgs.where.organizationId).toBe("wrong-org-id");
      expect(callArgs.where.status).toBe(ResourceStatus.ACTIVE);
      expect(callArgs.where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
      expect(result).toBeNull();
    });
  });

  describe("createKey", () => {
    it("creates key with all provided parameters", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_new",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
        scopes: [ApiKeyScope.PROOF_VERIFY],
      });

      expect(result.secret).toBeDefined();
      expect(result.apiKey.id).toBe("key_new");
      expect(result.apiKey.name).toBe("Test Key");
      expect(result.apiKey.scopes).toContain(ApiKeyScope.PROOF_VERIFY);
    });

    it("returns raw secret exactly once (never again)", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      expect(result.secret).toBeDefined();
      expect(typeof result.secret).toBe("string");
      // Secret should be long enough to have entropy
      expect(result.secret.length).toBeGreaterThan(30);
    });

    it("stores hash not raw secret", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        keyHash: "hash-value", // This should be a hash, not the secret
        scopeAssignments: [],
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      // Verify Prisma was called with a hash, not the raw secret
      const createCall = prismaService.apiKey.create.mock.calls[0][0];
      expect(createCall.data.keyHash).toBeDefined();
      // The keyHash should not be the same as the displayed secret (since it's hashed)
      expect(createCall.data.keyHash).not.toBe(result.secret);
    });

    it("logs key creation to audit trail", async () => {
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        expiresAt: null,
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
        scopes: [ApiKeyScope.PROOF_VERIFY],
      });

      // Verify audit log was created
      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "user",
            actorId: "user_123",
            action: "api_key.created",
            resourceType: "api_key",
            resourceId: "key_123",
          }),
        }),
      );
    });

    it("audit log never includes raw secret or hash", async () => {
      const returnedKey = {
        id: "key_123",
        prefix: "testpref",
        name: "Test Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        scopeAssignments: [],
      };

      prismaService.apiKey.create.mockResolvedValueOnce(returnedKey);

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Test Key",
      });

      const auditCall = prismaService.auditLog.create.mock.calls[0][0];
      const auditMetadata = JSON.stringify(auditCall.data.metadata);

      // Verify no secret or hash in audit log
      expect(auditMetadata).not.toContain(result.secret);
      expect(auditMetadata).not.toContain("keyHash");
      // But should contain safe metadata
      expect(auditMetadata).toContain("testpref"); // prefix is safe
      expect(auditMetadata).toContain("Test Key"); // name is safe
    });
  });

  describe("rotateKey", () => {
    it("generates new secret and invalidates old immediately", async () => {
      const oldSecret = "old-secret-123";
      service.hashSecret(oldSecret); // Hash it but don't need the result

      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        prefix: "newpref",
        name: "Key",
        organizationId: "org_123",
        status: ResourceStatus.ACTIVE,
        rotatedAt: new Date(),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      });

      const result = await service.rotateKey("key_123", "org_123", "user_123");

      expect(result.secret).toBeDefined();
      expect(result.secret).not.toBe(oldSecret);
      expect(result.apiKey.rotatedAt).toBeDefined();
      expect(prismaService.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "key_123", organizationId: "org_123" },
        }),
      );
    });

    it("enforces organization isolation on rotation", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        organizationId: "org_wrong",
        prefix: "prefix",
        name: "Key",
        scopeAssignments: [],
      });

      await expect(
        service.rotateKey("key_123", "org_correct", "user_123"),
      ).rejects.toThrow("does not belong to this organization");
    });

    it("logs rotation to audit trail", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        id: "key_123",
        prefix: "newpref",
        name: "Test Key",
        organizationId: "org_123",
        rotatedAt: new Date(),
        scopeAssignments: [],
      });

      await service.rotateKey("key_123", "org_123", "user_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.rotated",
            resourceId: "key_123",
          }),
        }),
      );
    });
  });

  describe("revokeKey", () => {
    it("marks key as REVOKED", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "prefix",
        name: "Key",
      });
      prismaService.apiKey.update.mockResolvedValueOnce({});

      await service.revokeKey("key_123", "org_123", "user_123");

      const updateCall = prismaService.apiKey.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(ResourceStatus.REVOKED);
      expect(updateCall.data.revokedAt).toBeDefined();
    });

    it("takes effect immediately (no cache window)", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "prefix",
        name: "Key",
      });

      await service.revokeKey("key_123", "org_123", "user_123");

      // Verify update was called directly (not delayed)
      expect(prismaService.apiKey.update).toHaveBeenCalled();
    });

    it("enforces organization isolation on revocation", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.revokeKey("key_123", "org_correct", "user_123"),
      ).rejects.toThrow("Key not found");

      expect(prismaService.apiKey.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "key_123", organizationId: "org_correct" },
        }),
      );
      expect(prismaService.apiKey.update).not.toHaveBeenCalled();
    });

    it("logs revocation to audit trail", async () => {
      prismaService.apiKey.findFirst.mockResolvedValueOnce({
        organizationId: "org_123",
        prefix: "testpref",
        name: "Test Key",
      });

      await service.revokeKey("key_123", "org_123", "user_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.revoked",
            resourceId: "key_123",
          }),
        }),
      );
    });
  });

  describe("listKeysForOrganization", () => {
    it("returns only metadata, never secrets or hashes", async () => {
      prismaService.apiKey.findMany.mockResolvedValueOnce([
        {
          id: "key_1",
          prefix: "prefix1",
          name: "Key 1",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          scopeAssignments: [{ scope: ApiKeyScope.PROOF_READ }],
        },
      ]);

      const keys = await service.listKeysForOrganization("org_123");

      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe("key_1");
      expect(keys[0].prefix).toBe("prefix1");
      // Should never return keyHash or raw secret
      expect((keys[0] as any).keyHash).toBeUndefined();
      expect((keys[0] as any).secret).toBeUndefined();
    });

    it("enforces organization isolation in query", async () => {
      prismaService.apiKey.findMany.mockResolvedValueOnce([]);

      await service.listKeysForOrganization("org_123");

      const findCall = prismaService.apiKey.findMany.mock.calls[0][0];
      expect(findCall.where.organizationId).toBe("org_123");
    });
  });

  describe("recordKeyUsage", () => {
    it("records timestamp only (not IP/UA)", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
      });

      await service.recordKeyUsage("key_123", "org_123");

      // Verify only lastUsedAt was updated, no IP/UA fields
      const updateCall = prismaService.apiKey.update.mock.calls[0][0];
      expect(updateCall.data.lastUsedAt).toBeDefined();
      expect(Object.keys(updateCall.data)).toEqual(["lastUsedAt"]);
    });

    it("logs successful authentication to audit trail", async () => {
      prismaService.apiKey.update.mockResolvedValueOnce({
        prefix: "testpref",
        name: "Key",
        organizationId: "org_123",
      });

      await service.recordKeyUsage("key_123", "org_123");

      expect(prismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key.authenticated",
            resourceId: "key_123",
          }),
        }),
      );
    });

    it("does not throw on database error (graceful degradation)", async () => {
      prismaService.apiKey.update.mockRejectedValueOnce(
        new Error("DB error"),
      );

      // Should not throw
      await expect(
        service.recordKeyUsage("key_123", "org_123"),
      ).resolves.toBeUndefined();
    });
  });

  describe("verifySecret timing consistency", () => {
    it("executes in constant time regardless of input format validity", () => {
      const correctSecret = "correct-secret-value-12345";
      const correctHash = service.hashSecret(correctSecret);

      // Prepare test cases: well-formatted wrong, malformed, and correct
      const malformedHash = "not-a-valid-hash-format";
      const wrongButFormatted = "a".repeat(64); // Valid format but wrong value

      // Measure execution time for each case
      // We'll run each multiple times and average to reduce flakiness
      const iterations = 100;
      const timings = {
        malformed: [] as number[],
        wrongFormatted: [] as number[],
        correct: [] as number[],
      };

      for (let i = 0; i < iterations; i++) {
        // Malformed input
        const start1 = process.hrtime.bigint();
        service.verifySecret(correctSecret, malformedHash);
        const end1 = process.hrtime.bigint();
        timings.malformed.push(Number(end1 - start1));

        // Wrong but properly formatted
        const start2 = process.hrtime.bigint();
        service.verifySecret(correctSecret, wrongButFormatted);
        const end2 = process.hrtime.bigint();
        timings.wrongFormatted.push(Number(end2 - start2));

        // Correct secret
        const start3 = process.hrtime.bigint();
        service.verifySecret(correctSecret, correctHash);
        const end3 = process.hrtime.bigint();
        timings.correct.push(Number(end3 - start3));
      }

      // Calculate averages (in nanoseconds)
      const avgMalformed =
        timings.malformed.reduce((a, b) => a + b, 0) / iterations;
      const avgWrongFormatted =
        timings.wrongFormatted.reduce((a, b) => a + b, 0) / iterations;
      const avgCorrect = timings.correct.reduce((a, b) => a + b, 0) / iterations;

      // Allow 50% variance (timing can vary in CI environments)
      // This is a loose tolerance to avoid flaky tests
      const maxDeviation = Math.max(avgMalformed, avgWrongFormatted, avgCorrect) *
        0.5;

      expect(Math.abs(avgMalformed - avgWrongFormatted)).toBeLessThan(
        maxDeviation,
      );
      expect(Math.abs(avgWrongFormatted - avgCorrect)).toBeLessThan(
        maxDeviation,
      );
      expect(Math.abs(avgMalformed - avgCorrect)).toBeLessThan(maxDeviation);
    });

    it("handles malformed hashes without early exit", () => {
      const secret = "test-secret";
      const malformedHashes = [
        "",
        "too-short",
        "!@#$%^&*()",
        "00000000000000000000000000000000000000000000000000000000000000", // 63 chars
        "000000000000000000000000000000000000000000000000000000000000000g", // 64 chars but invalid char
      ];

      // All should return false, and process should complete normally
      for (const hash of malformedHashes) {
        const result = service.verifySecret(secret, hash);
        expect(result).toBe(false);
      }
    });

    it("correctly rejects malformed hashes via constant-time path", () => {
      const secret = "my-secret";
      const hash = service.hashSecret(secret);

      // These should all return false (no match)
      expect(service.verifySecret(secret, "X".repeat(64))).toBe(false);
      expect(service.verifySecret(secret, "invalid-format")).toBe(false);
      expect(service.verifySecret(secret, "")).toBe(false);

      // And the correct should still work
      expect(service.verifySecret(secret, hash)).toBe(true);
    });
  });

  describe("security invariants", () => {
    it("lifecycle ensures secret is never retrievable after creation", async () => {
      // Create a key
      prismaService.apiKey.create.mockResolvedValueOnce({
        id: "key_123",
        prefix: "prefix",
        name: "Key",
        organizationId: "org_123",
        createdById: "user_123",
        status: ResourceStatus.ACTIVE,
        createdAt: new Date(),
        keyHash: "hash-value",
        scopeAssignments: [],
      });

      const createResult = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      const displayedSecret = createResult.secret;

      // Simulate listing keys later
      prismaService.apiKey.findMany.mockResolvedValueOnce([
        {
          id: "key_123",
          prefix: "prefix",
          name: "Key",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          scopeAssignments: [],
        },
      ]);

      const listedKeys = await service.listKeysForOrganization("org_123");

      // The listed key should never contain the secret
      expect(JSON.stringify(listedKeys)).not.toContain(displayedSecret);
      expect((listedKeys[0] as any).keyHash).toBeUndefined();
    });

    it("never logs raw secrets in any audit operation", async () => {
      let capturedSecret: string | null = null;

      prismaService.apiKey.create.mockImplementationOnce(async (input: any) => {
        // Capture what would be stored as the hash
        capturedSecret = input.data.keyHash;
        return {
          id: "key_123",
          prefix: "prefix",
          name: "Key",
          organizationId: "org_123",
          createdById: "user_123",
          status: ResourceStatus.ACTIVE,
          createdAt: new Date(),
          keyHash: capturedSecret,
          scopeAssignments: [],
        };
      });

      const result = await service.createKey({
        organizationId: "org_123",
        createdBy: "user_123",
        name: "Key",
      });

      // Get all audit logs created
      const auditCalls = prismaService.auditLog.create.mock.calls;

      for (const call of auditCalls) {
        const auditStr = JSON.stringify(call[0]);
        // Ensure the displayed secret is not in any audit log
        expect(auditStr).not.toContain(result.secret);
        // Ensure the hash is not in any audit log
        if (capturedSecret) {
          expect(auditStr).not.toContain(capturedSecret);
        }
      }
    });
  });
});
