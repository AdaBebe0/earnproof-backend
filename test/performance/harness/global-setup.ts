import { PrismaClient } from "@prisma/client";
import { openAdminConnection } from "../../integration/harness/admin";
import { applyMigrations } from "../../integration/harness/migrate";
import { withDeadline } from "../../integration/harness/bounded";
import type { IntegrationConfig } from "../../integration/harness/config";
import { performanceConfig, PerformanceConfig } from "./config";
import { seedScaleFixture, DEFAULT_SCALE, SMOKE_SCALE } from "./scale-seed";

/**
 * Adapts a {@link PerformanceConfig} to the shape `openAdminConnection` and
 * `applyMigrations` expect.
 *
 * Those two functions are shared verbatim from the integration harness
 * because dropping/creating a database and running `prisma migrate deploy`
 * has nothing integration-suite-specific about it — duplicating them here
 * would be the thing to avoid. They take an `IntegrationConfig`, which
 * carries per-worker fields (`workerName`, `workerUrl`, …) this suite has no
 * use for; this adapter fills those with values that are never read by the
 * two functions actually called; `urlFor` is filled in in case something
 * does need it, so the same targets are addressed.
 */
function asIntegrationConfig(config: PerformanceConfig): IntegrationConfig {
  return {
    baseName: config.baseName,
    templateName: config.databaseName,
    workerName: config.databaseName,
    workerPrefix: `${config.baseName}_perf`,
    maintenanceUrl: config.maintenanceUrl,
    templateUrl: config.databaseUrl,
    workerUrl: config.databaseUrl,
    adminTimeoutMs: config.adminTimeoutMs,
    migrateTimeoutMs: config.migrateTimeoutMs,
    keepDatabases: config.keepDatabase,
    urlFor: (databaseName: string) => {
      const target = new URL(config.databaseUrl);
      target.pathname = `/${databaseName}`;
      return target.toString();
    },
  };
}

/**
 * Builds and seeds the shared performance database, once per run.
 *
 * If `TEST_DATABASE_URL` is not set (or does not resolve to a reachable
 * PostgreSQL server), this writes a notice and returns without throwing —
 * `*.perf-spec.ts` files each check the same condition in `beforeAll` and
 * call `describe.skip`, so "no database available" is a skipped suite, not a
 * failed build. See docs/database-performance.md for why the suite is
 * designed to degrade this way rather than requiring Postgres unconditionally.
 */
export default async function globalSetup(): Promise<void> {
  const config = performanceConfig();
  if (!config) {
    process.stdout.write(
      "\nPerformance harness: TEST_DATABASE_URL is not set. Skipping seed; " +
        "every performance test will report itself skipped. See " +
        "docs/database-performance.md to run this suite against a real database.\n",
    );
    return;
  }

  const started = Date.now();
  const integrationShapedConfig = asIntegrationConfig(config);
  let admin;
  try {
    admin = await openAdminConnection(integrationShapedConfig);
  } catch (error) {
    process.stdout.write(
      `\nPerformance harness: could not reach PostgreSQL at the configured ` +
        `TEST_DATABASE_URL (${
          error instanceof Error ? error.message : "unknown error"
        }). Skipping seed; every performance test will report itself skipped.\n`,
    );
    return;
  }

  try {
    await admin.drop(config.databaseName);
    await admin.create(config.databaseName);
  } finally {
    await admin.close();
  }

  await applyMigrations(config.databaseUrl, integrationShapedConfig);

  const client = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await withDeadline("Connecting to the performance database", config.adminTimeoutMs, () =>
      client.$connect(),
    );

    const scale = config.smokeScale ? SMOKE_SCALE : DEFAULT_SCALE;
    await withDeadline(
      "Seeding the performance database's scale fixture",
      config.seedTimeoutMs,
      () => seedScaleFixture(client, scale),
    );
  } finally {
    await client.$disconnect();
  }

  process.stdout.write(
    `\nPerformance harness: seeded in ${Date.now() - started}ms ` +
      `(${config.smokeScale ? "smoke" : "default"} scale)\n`,
  );
}
