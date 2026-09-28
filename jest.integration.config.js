/**
 * Integration test runner.
 *
 * Kept separate from `jest.config.js` rather than folded into it as a project.
 * The unit suite must stay runnable with no database at all — that is what makes
 * it the fast feedback loop — and a single config would make every unit run
 * depend on `TEST_DATABASE_URL` being set.
 *
 * Workers run in parallel on purpose. Each gets its own database (see
 * `test/integration/harness/database.ts`), so parallelism is the assertion:
 * a test that leaks state across workers fails here rather than surviving until
 * someone drops `--runInBand`.
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  moduleFileExtensions: ["js", "json", "ts"],
  testMatch: ["<rootDir>/test/integration/**/*.int-spec.ts"],
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  globalSetup: "<rootDir>/test/integration/harness/global-setup.ts",
  globalTeardown: "<rootDir>/test/integration/harness/global-teardown.ts",
  // Runs before the test framework: repoints DATABASE_URL at this worker's
  // database, so application providers connect to the right place.
  setupFiles: ["<rootDir>/test/integration/harness/environment.ts"],
  // Runs after the test framework: installs failure redaction and timeouts.
  setupFilesAfterEnv: ["<rootDir>/test/integration/harness/setup-after-env.ts"],
  // A database round trip is slower than a mock; the per-test deadline in
  // setup-after-env.ts is the one that matters and is configurable.
  testTimeout: 30000,
  // Surfaces a connection a test forgot to close, which would otherwise present
  // as global teardown failing to drop a database.
  detectOpenHandles: false,
  forceExit: false,
};
