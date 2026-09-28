import { safe } from "./redaction";

/**
 * Resolution and validation of the integration-test database target.
 *
 * The harness creates and drops databases, and truncates every table between
 * tests. That is only acceptable against a target that is unambiguously
 * disposable, so configuration fails closed: an unset, unparseable, or
 * production-looking target is refused before a single connection is opened.
 * Refusing after connecting would already be later than anyone wants.
 *
 * The database named in `TEST_DATABASE_URL` is never itself connected to. It
 * supplies the *naming base* for the databases the harness owns:
 *
 *   <base>_template   migrated once per run, then cloned
 *   <base>_w<worker>  one per Jest worker, cloned from the template
 *
 * Keeping the named database untouched means pointing the harness at an
 * existing database cannot destroy its contents, and it removes the need for
 * anyone to pre-create anything beyond the role.
 */

/** Maintenance database used for CREATE/DROP DATABASE. Always present in PostgreSQL. */
const MAINTENANCE_DATABASE = "postgres";

/** Bound on any single administrative statement (connect, create, drop, truncate). */
const DEFAULT_ADMIN_TIMEOUT_MS = 15_000;

/** Bound on `prisma migrate deploy` against the template database. */
const DEFAULT_MIGRATE_TIMEOUT_MS = 120_000;

/**
 * A target whose name does not contain this token is refused.
 *
 * The harness issues `DROP DATABASE` and `TRUNCATE`. A naming convention is a
 * weak guarantee in general, but it is the one guarantee available before
 * connecting, and it reliably stops the common accident: reusing a development
 * `DATABASE_URL` for `TEST_DATABASE_URL`.
 */
const REQUIRED_NAME_TOKEN = "test";

/** PostgreSQL identifiers the harness will generate and quote. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** PostgreSQL truncates identifiers beyond this length, which would alias databases. */
const MAX_IDENTIFIER_LENGTH = 63;

export interface IntegrationConfig {
  /** Naming base taken from `TEST_DATABASE_URL`, e.g. `earnproof_test`. */
  baseName: string;
  /** Name of the migrated template database. */
  templateName: string;
  /** Name of this worker's database. */
  workerName: string;
  /** Prefix matching every worker database, for teardown. */
  workerPrefix: string;
  /** Connection URL for the maintenance database. */
  maintenanceUrl: string;
  /** Connection URL for the template database. */
  templateUrl: string;
  /** Connection URL for this worker's database. */
  workerUrl: string;
  adminTimeoutMs: number;
  migrateTimeoutMs: number;
  /** When true, teardown leaves the databases in place for inspection. */
  keepDatabases: boolean;
  urlFor(databaseName: string): string;
}

export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(safe(message));
    this.name = "IntegrationConfigError";
  }
}

function positiveIntFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new IntegrationConfigError(
      `${key} must be a positive number of milliseconds`,
    );
  }
  return Math.floor(value);
}

function assertSafeIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new IntegrationConfigError(
      `${label} must match ${SAFE_IDENTIFIER.source}; the harness quotes it into DDL and will not interpolate anything else`,
    );
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new IntegrationConfigError(
      `${label} exceeds PostgreSQL's ${MAX_IDENTIFIER_LENGTH}-character identifier limit, which would silently alias two databases`,
    );
  }
}

/**
 * Jest numbers workers from 1. Outside a worker (global setup/teardown) the
 * variable is absent, and no worker database is addressed.
 */
function workerId(): string {
  const raw = process.env.JEST_WORKER_ID ?? "1";
  return /^[0-9]+$/.test(raw) ? raw : "1";
}

let cached: IntegrationConfig | undefined;

export function integrationConfig(): IntegrationConfig {
  if (cached) return cached;

  if (process.env.NODE_ENV === "production") {
    throw new IntegrationConfigError(
      "Integration tests refuse to run with NODE_ENV=production",
    );
  }

  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new IntegrationConfigError(
      "TEST_DATABASE_URL is not set. See docs/integration-testing.md for the " +
        "role and URL the harness expects. It is deliberately separate from " +
        "DATABASE_URL so a development database can never be the target.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IntegrationConfigError(
      "TEST_DATABASE_URL is not a parseable URL. An unknown target is not a safe target.",
    );
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new IntegrationConfigError(
      `TEST_DATABASE_URL must use the postgresql:// scheme, not ${url.protocol}`,
    );
  }

  const baseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!baseName) {
    throw new IntegrationConfigError(
      "TEST_DATABASE_URL must name a database; the name is used as the prefix for the databases the harness creates",
    );
  }

  if (!baseName.toLowerCase().includes(REQUIRED_NAME_TOKEN)) {
    throw new IntegrationConfigError(
      `TEST_DATABASE_URL names a database without "${REQUIRED_NAME_TOKEN}" in it. ` +
        "The harness creates, truncates and drops databases derived from this name, " +
        "so it refuses any target that is not obviously disposable.",
    );
  }

  assertSafeIdentifier(baseName, "The database name in TEST_DATABASE_URL");

  const templateName = `${baseName}_template`;
  const workerPrefix = `${baseName}_w`;
  const workerName = `${workerPrefix}${workerId()}`;

  assertSafeIdentifier(templateName, "The derived template database name");
  assertSafeIdentifier(workerName, "The derived worker database name");

  const urlFor = (databaseName: string): string => {
    assertSafeIdentifier(databaseName, "Database name");
    const target = new URL(url.toString());
    target.pathname = `/${databaseName}`;
    return target.toString();
  };

  /**
   * Worker connections get an explicit pool size.
   *
   * Prisma otherwise sizes the pool from the host's CPU count, which makes the
   * concurrency tests behave differently on a laptop and on a two-core CI
   * runner: below the pool size, concurrent transactions genuinely overlap;
   * at or above it they queue and the test measures the pool rather than the
   * database. Pinning the value keeps the verdict the same everywhere.
   */
  const workerUrlWithPool = (): string => {
    const target = new URL(urlFor(workerName));
    if (!target.searchParams.has("connection_limit")) {
      target.searchParams.set("connection_limit", "10");
    }
    return target.toString();
  };

  cached = {
    baseName,
    templateName,
    workerName,
    workerPrefix,
    maintenanceUrl: urlFor(MAINTENANCE_DATABASE),
    templateUrl: urlFor(templateName),
    workerUrl: workerUrlWithPool(),
    adminTimeoutMs: positiveIntFromEnv(
      "INTEGRATION_ADMIN_TIMEOUT_MS",
      DEFAULT_ADMIN_TIMEOUT_MS,
    ),
    migrateTimeoutMs: positiveIntFromEnv(
      "INTEGRATION_MIGRATE_TIMEOUT_MS",
      DEFAULT_MIGRATE_TIMEOUT_MS,
    ),
    keepDatabases: process.env.INTEGRATION_KEEP_DATABASES === "true",
    urlFor,
  };

  return cached;
}

/** Test seam: forces the next {@link integrationConfig} call to re-read the environment. */
export function resetIntegrationConfigCache(): void {
  cached = undefined;
}
