/**
 * End-to-end test runner.
 *
 * Exercises full HTTP request/response cycles through the real Nest
 * application (routing, guards, pipes, interceptors, the global exception
 * filter) against a real PostgreSQL database, rather than calling providers
 * directly as `jest.integration.config.js` does.
 *
 * Reuses the integration harness's database lifecycle (per-worker database
 * cloned from a migrated template, truncated between tests) unchanged: the
 * isolation properties that make the integration suite parallel-safe apply
 * here for the same reasons. Only the app boot layer (test/e2e/harness/app.ts)
 * and the specs themselves are e2e-specific.
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  moduleFileExtensions: ["js", "json", "ts"],
  testMatch: ["<rootDir>/test/e2e/**/*.e2e-spec.ts"],
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  globalSetup: "<rootDir>/test/integration/harness/global-setup.ts",
  globalTeardown: "<rootDir>/test/integration/harness/global-teardown.ts",
  setupFiles: ["<rootDir>/test/integration/harness/environment.ts"],
  setupFilesAfterEnv: ["<rootDir>/test/integration/harness/setup-after-env.ts"],
  // HTTP round trips through the full pipeline are slower than a direct
  // provider call; the per-test deadline in setup-after-env.ts still applies.
  testTimeout: 30000,
  detectOpenHandles: false,
  forceExit: false,
};
