/**
 * Worker environment defaults for the performance suite.
 *
 * Mirrors `test/integration/harness/environment.ts`: fills in defaults an
 * operator has not already exported, so running the suite needs only
 * `TEST_DATABASE_URL`. Every value is a fixed, published example constant —
 * none is a credential.
 */

const DEFAULTS: Record<string, string> = {
  NODE_ENV: "test",
  PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}
