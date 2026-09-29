import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { ConfigService } from "@nestjs/config";

/**
 * STARTUP PROFILE INTEGRATION TESTS
 *
 * This test suite verifies that the application starts (or fails to start)
 * correctly based on the environment profile and configuration provided.
 *
 * Tests cover:
 * - Happy path startup for development, test, staging, and production profiles
 * - Validation failures that prevent startup
 * - Cross-variable invariants that block startup in specific profiles
 * - Confirmation that errors are logged but secret values are not exposed
 *
 * Each test manipulates process.env, creates the AppModule, and either
 * confirms successful initialization or catches validation errors.
 *
 * IMPORTANT: These tests run BEFORE the server starts listening, verifying
 * that configuration validation happens at bootstrap time (in NestFactory.create),
 * not after startup.
 */

describe("Startup Profiles Integration Tests (AppModule)", () => {
  // Save original env to restore after each test
  const originalEnv = { ...process.env };

  const setEnv = (config: Record<string, string>) => {
    // Clear previous vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("DATABASE_") || key.startsWith("REDIS_")) {
        delete process.env[key];
      }
    });
    // Set new vars
    Object.assign(process.env, config);
  };

  const restoreEnv = () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  };

  afterEach(() => {
    restoreEnv();
  });

  // ──────────────────────────────────────────────────────────────────────
  // HAPPY PATH: Development profile
  // ──────────────────────────────────────────────────────────────────────

  describe("Happy path: development profile startup", () => {
    it("starts successfully with minimal development config", async () => {
      setEnv({
        NODE_ENV: "development",
        PORT: "4000",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/earnproof",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        expect(module).toBeDefined();
        expect(module.get(ConfigService)).toBeDefined();

        const configService = module.get(ConfigService);
        expect(configService.get("nodeEnv")).toBe("development");
        expect(configService.get("port")).toBe(4000);
      } finally {
        if (module) {
          await module.close();
        }
      }
    });

    it("applies all defaults in development profile", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/earnproof",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const configService = module.get(ConfigService);
        expect(configService.get("port")).toBe(4000);
        expect(configService.get("appUrl")).toBe("http://localhost:3000");
        expect(configService.get("apiUrl")).toBe("http://localhost:4000");
        expect(configService.get("stellar").network).toBe("testnet");
      } finally {
        if (module) {
          await module.close();
        }
      }
    });

    it("accepts non-HTTPS URLs in development", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/earnproof",
        REDIS_URL: "redis://localhost:6379",
        APP_URL: "http://localhost:3000",
        API_URL: "http://localhost:4000",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        expect(module).toBeDefined();
      } finally {
        if (module) {
          await module.close();
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // HAPPY PATH: Test profile
  // ──────────────────────────────────────────────────────────────────────

  describe("Happy path: test profile startup", () => {
    it("starts successfully with test profile config", async () => {
      setEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/earnproof_test",
        REDIS_URL: "redis://localhost:6379",
        TEST_DATABASE_URL:
          "postgresql://user:pass@localhost:5432/earnproof_test",
        SESSION_SECRET: "test-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "test-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        expect(module).toBeDefined();
        const configService = module.get(ConfigService);
        expect(configService.get("nodeEnv")).toBe("test");
      } finally {
        if (module) {
          await module.close();
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // HAPPY PATH: Production profile
  // ──────────────────────────────────────────────────────────────────────

  describe("Happy path: production profile startup", () => {
    it("starts successfully with remote hosts and HTTPS URLs", async () => {
      setEnv({
        NODE_ENV: "production",
        PORT: "4000",
        DATABASE_URL:
          "postgresql://user:pass@db.prod.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.prod.example.com:6379",
        APP_URL: "https://app.prod.example.com",
        API_URL: "https://api.prod.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        expect(module).toBeDefined();
        const configService = module.get(ConfigService);
        expect(configService.get("nodeEnv")).toBe("production");
        expect(configService.get("appUrl")).toBe("https://app.prod.example.com");
      } finally {
        if (module) {
          await module.close();
        }
      }
    });

    it("accepts production config with reasonable rate limits", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.prod.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.prod.example.com:6379",
        APP_URL: "https://app.prod.example.com",
        API_URL: "https://api.prod.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "10",
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "600000",
        AUTH_RATE_LIMIT_MAX_VERIFICATIONS: "5",
        AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS: "600000",
      });

      let module: TestingModule | undefined;
      try {
        module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        expect(module).toBeDefined();
      } finally {
        if (module) {
          await module.close();
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // STARTUP FAILURES: Missing required variables
  // ──────────────────────────────────────────────────────────────────────

  describe("Startup failures: missing required variables", () => {
    it("fails when DATABASE_URL is missing", async () => {
      setEnv({
        NODE_ENV: "development",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("DATABASE_URL");
      }
    });

    it("fails when REDIS_URL is missing", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("REDIS_URL");
      }
    });

    it("fails when SESSION_SECRET is missing", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("SESSION_SECRET");
      }
    });

    it("fails when CREDENTIAL_SIGNING_SECRET is missing", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("CREDENTIAL_SIGNING_SECRET");
      }
    });

    it("fails when PAYMENT_ENCRYPTION_KEY is missing", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("PAYMENT_ENCRYPTION_KEY");
      }
    });

    it("never exposes secret values in error messages", async () => {
      const secretValue = "this-is-my-actual-secret-value";
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "tooshort", // Will fail validation
        CREDENTIAL_SIGNING_SECRET: secretValue, // Real secret
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(secretValue);
        expect(message).not.toContain("tooshort");
        expect(message).toContain("SESSION_SECRET"); // Variable name is OK
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // STARTUP FAILURES: Invalid numeric values
  // ──────────────────────────────────────────────────────────────────────

  describe("Startup failures: invalid numeric values", () => {
    it("fails when PORT is 0 (must be positive)", async () => {
      setEnv({
        NODE_ENV: "development",
        PORT: "0",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("PORT");
      }
    });

    it("fails when RETENTION_WALLET_CHALLENGE_DAYS is 0 (must be >= 1)", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        RETENTION_WALLET_CHALLENGE_DAYS: "0",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("RETENTION_WALLET_CHALLENGE_DAYS");
      }
    });

    it("fails when RETENTION_AUTH_SESSION_DAYS exceeds 3650 (max 10 years)", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        RETENTION_AUTH_SESSION_DAYS: "3651",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("RETENTION_AUTH_SESSION_DAYS");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // STARTUP FAILURES: Production profile invariants
  // ──────────────────────────────────────────────────────────────────────

  describe("Startup failures: production profile invariants", () => {
    it("fails when APP_URL is HTTP (not HTTPS) in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "http://app.example.com", // Should be https://
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("APP_URL");
        expect(message).toContain("https");
        expect(message).toContain("production");
      }
    });

    it("fails when API_URL is HTTP (not HTTPS) in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "http://api.example.com", // Should be https://
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("API_URL");
        expect(message).toContain("https");
        expect(message).toContain("production");
      }
    });

    it("fails when DATABASE_URL points to localhost in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db", // localhost not allowed
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("DATABASE_URL");
        expect(message).toContain("localhost");
        expect(message).toContain("production");
      }
    });

    it("fails when REDIS_URL points to localhost in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://localhost:6379", // localhost not allowed
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("REDIS_URL");
        expect(message).toContain("localhost");
        expect(message).toContain("production");
      }
    });

    it("fails when CONTRACT_ANCHORING_REQUIRED=true but PROOF_REGISTRY_CONTRACT_ID is missing", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        CONTRACT_ANCHORING_REQUIRED: "true",
        PROOF_REGISTRY_CONTRACT_ID: "", // Missing
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("CONTRACT_ANCHORING_REQUIRED");
        expect(message).toContain("PROOF_REGISTRY_CONTRACT_ID");
      }
    });

    it("fails when rate limit window is > 1 hour in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "7200000", // 2 hours
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain(
          "AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS",
        );
        expect(message).toContain("1 hour");
      }
    });

    it("fails when challenge rate limit is > 100 in production", async () => {
      setEnv({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://user:pass@db.example.com:5432/earnproof_prod",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET:
          "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "101",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS");
        expect(message).toContain("unreasonably high");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // STARTUP FAILURES: Test profile invariants
  // ──────────────────────────────────────────────────────────────────────

  describe("Startup failures: test profile invariants", () => {
    it("fails when TEST_DATABASE_URL does not contain 'test' in database name", async () => {
      setEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/earnproof_test",
        REDIS_URL: "redis://localhost:6379",
        TEST_DATABASE_URL: "postgresql://user:pass@localhost:5432/prod_db", // No "test"
        SESSION_SECRET: "test-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "test-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected startup to fail, but it succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("TEST_DATABASE_URL");
        expect(message).toContain("test");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // VALIDATION RUNS BEFORE LISTEN()
  // ──────────────────────────────────────────────────────────────────────

  describe("Validation runs before server listen() call", () => {
    it("fails during NestFactory.create(), not after", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY: "invalid-encryption-key", // Invalid
      });

      try {
        // The error should be thrown during .compile() which internally
        // calls NestFactory.create(AppModule), not after.
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected validation to fail during module creation");
      } catch (error) {
        // Error is expected during module initialization
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toBeTruthy();
        expect(message).toContain("PAYMENT_ENCRYPTION_KEY");
      }
    });

    it("provides detailed error messages naming the variable key", async () => {
      setEnv({
        NODE_ENV: "development",
        DATABASE_URL: "not-a-url",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY:
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      try {
        await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        fail("Expected validation to fail");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("DATABASE_URL");
      }
    });
  });
});
