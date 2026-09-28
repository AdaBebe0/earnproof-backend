import { integrationConfig } from "./config";

/**
 * Worker environment, applied before the test framework loads.
 *
 * `DATABASE_URL` is repointed at *this worker's* database. That is what lets
 * the real application providers — `PrismaService`, and everything Nest builds
 * on top of it — run unmodified against an isolated database. Without it every
 * worker would share whatever `DATABASE_URL` happened to hold, which is both a
 * correctness problem and the accident this harness is meant to prevent.
 *
 * The remaining values are defaults, not overrides: an operator who has already
 * exported a value keeps it. They exist so that running the suite needs one
 * environment variable (`TEST_DATABASE_URL`) rather than a dozen, while still
 * satisfying `validateEnv`, which refuses to construct the config otherwise.
 *
 * Every default here is a fixed, obviously-fake constant. None is a credential:
 * the signing and encryption keys are the published example values, so a leak
 * of this file discloses nothing.
 */

const config = integrationConfig();

process.env.DATABASE_URL = config.workerUrl;

const DEFAULTS: Record<string, string> = {
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  STELLAR_NETWORK: "testnet",
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  SESSION_SECRET: "integration-test-session-secret",
  CREDENTIAL_SIGNING_SECRET: "integration-test-signing-secret",
  // The .env.example key: 32 bytes of ASCII, base64-encoded.
  PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  CONTRACT_ANCHORING_ENABLED: "false",
  CONTRACT_ANCHORING_REQUIRED: "false",
  ISSUER_REGISTRY_ENABLED: "false",
  VERIFICATION_HASH_SALT_V0: "integration-test-salt-v0-not-a-real-secret",
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}
