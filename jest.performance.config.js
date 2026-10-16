/**
 * Performance / query-plan regression suite runner.
 *
 * Kept separate from both `jest.config.js` and `jest.integration.config.js`:
 *
 * - It needs its own `globalSetup`/`globalTeardown` to build and seed a
 *   large, shared fixture database once per run rather than a fresh
 *   near-empty database per worker — a query plan only tells you anything
 *   at scale (see `test/performance/harness/scale-seed.ts`).
 * - It must run serially (`--runInBand` below via `maxWorkers: 1`). Parallel
 *   workers would each try to read `EXPLAIN ANALYZE` timings from the same
 *   shared database while other workers hammer it with their own queries,
 *   which would make execution-time budgets meaningless.
 *
 * See docs/database-performance.md for how to run this locally and what to
 * do when TEST_DATABASE_URL is not set.
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  moduleFileExtensions: ["js", "json", "ts"],
  // testRegex, not testMatch: in some environments (observed on Windows with
  // the worktree checked out under a path containing a dot-segment) Jest's
  // glob-based testMatch silently resolves to zero matches while the
  // equivalent testRegex behaves normally. testRegex is scoped to
  // /test/performance/ explicitly so it cannot pick up the integration or
  // unit suites' spec files.
  testRegex: "test[\\\\/]performance[\\\\/].*\\.perf-spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  globalSetup: "<rootDir>/test/performance/harness/global-setup.ts",
  globalTeardown: "<rootDir>/test/performance/harness/global-teardown.ts",
  setupFiles: ["<rootDir>/test/performance/harness/environment.ts"],
  // Query-plan assertions are meaningless if two test files race against the
  // same shared, seeded database at once.
  maxWorkers: 1,
  testTimeout: 60000,
  detectOpenHandles: false,
  forceExit: false,
};
