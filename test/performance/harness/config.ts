/**
 * Resolution of the performance-suite database target.
 *
 * Deliberately reuses the same `TEST_DATABASE_URL` variable, safety checks,
 * and naming scheme as `test/integration/harness/config.ts` (a target must
 * parse as a URL, use the `postgresql://` scheme, and name a database with
 * "test" in it) — this suite creates and drops its own database and must be
 * just as unable to point at anything that looks like production.
 *
 * It does not reuse the integration harness's per-Jest-worker naming,
 * because the performance suite wants the opposite isolation model: one
 * shared, once-seeded database for the whole run, not one per worker. The
 * scale fixture is expensive to build (tens of thousands of rows) and is
 * read-only from every test's perspective — EXPLAIN ANALYZE executes the
 * query for real but nothing here mutates the seeded rows — so there is
 * nothing to gain from isolating workers from each other and a lot of
 * seeding time to lose by doing it anyway.
 */

const REQUIRED_NAME_TOKEN = "test";
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

export interface PerformanceConfig {
  baseName: string;
  /** Name of the single shared, seeded performance database. */
  databaseName: string;
  maintenanceUrl: string;
  databaseUrl: string;
  adminTimeoutMs: number;
  migrateTimeoutMs: number;
  seedTimeoutMs: number;
  /** When true, teardown leaves the database in place for inspection. */
  keepDatabase: boolean;
  /** True when the fixture should use the reduced SMOKE_SCALE instead of DEFAULT_SCALE. */
  smokeScale: boolean;
}

export class PerformanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerformanceConfigError";
  }
}

function positiveIntFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PerformanceConfigError(
      `${key} must be a positive number of milliseconds`,
    );
  }
  return Math.floor(value);
}

function assertSafeIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new PerformanceConfigError(
      `${label} must match ${SAFE_IDENTIFIER.source}; the harness quotes it into DDL and will not interpolate anything else`,
    );
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new PerformanceConfigError(
      `${label} exceeds PostgreSQL's ${MAX_IDENTIFIER_LENGTH}-character identifier limit`,
    );
  }
}

let cached: PerformanceConfig | undefined;

/**
 * Reads and validates the performance-suite target, or returns `undefined`
 * when no target is configured.
 *
 * Unlike the integration harness's `integrationConfig()`, this does not
 * throw when `TEST_DATABASE_URL` is unset — an unset or unreachable database
 * is the expected state in many environments (this one included, in CI
 * without Docker), and the suite is written to skip in that case rather than
 * fail the build. It still throws on a *present but unsafe* target, because
 * silently refusing to validate would be worse than not running at all.
 */
export function performanceConfig(): PerformanceConfig | undefined {
  if (cached) return cached;

  if (process.env.NODE_ENV === "production") {
    throw new PerformanceConfigError(
      "The performance suite refuses to run with NODE_ENV=production",
    );
  }

  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PerformanceConfigError(
      "TEST_DATABASE_URL is not a parseable URL",
    );
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new PerformanceConfigError(
      `TEST_DATABASE_URL must use the postgresql:// scheme, not ${url.protocol}`,
    );
  }

  const baseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!baseName) {
    throw new PerformanceConfigError(
      "TEST_DATABASE_URL must name a database",
    );
  }
  if (!baseName.toLowerCase().includes(REQUIRED_NAME_TOKEN)) {
    throw new PerformanceConfigError(
      `TEST_DATABASE_URL names a database without "${REQUIRED_NAME_TOKEN}" in it; ` +
        "the performance harness creates, seeds and drops a database derived " +
        "from this name, so it refuses any target that is not obviously disposable.",
    );
  }
  assertSafeIdentifier(baseName, "The database name in TEST_DATABASE_URL");

  const databaseName = `${baseName}_perf`;
  assertSafeIdentifier(databaseName, "The derived performance database name");

  const urlFor = (name: string): string => {
    const target = new URL(url.toString());
    target.pathname = `/${name}`;
    return target.toString();
  };

  cached = {
    baseName,
    databaseName,
    maintenanceUrl: urlFor("postgres"),
    databaseUrl: urlFor(databaseName),
    adminTimeoutMs: positiveIntFromEnv("INTEGRATION_ADMIN_TIMEOUT_MS", 15_000),
    migrateTimeoutMs: positiveIntFromEnv(
      "INTEGRATION_MIGRATE_TIMEOUT_MS",
      120_000,
    ),
    seedTimeoutMs: positiveIntFromEnv("PERFORMANCE_SEED_TIMEOUT_MS", 180_000),
    keepDatabase: process.env.INTEGRATION_KEEP_DATABASES === "true",
    smokeScale: process.env.PERFORMANCE_SMOKE_SCALE === "true",
  };

  return cached;
}

/** Test seam: forces the next {@link performanceConfig} call to re-read the environment. */
export function resetPerformanceConfigCache(): void {
  cached = undefined;
}
