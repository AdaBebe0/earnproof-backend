import { openAdminConnection } from "../../integration/harness/admin";
import { performanceConfig } from "./config";

/**
 * Drops the shared performance database, mirroring
 * `test/integration/harness/global-teardown.ts`.
 *
 * A no-op when no target was configured (nothing was created) or when
 * `INTEGRATION_KEEP_DATABASES=true` (left in place for inspection, same
 * variable the integration harness uses so one setting controls both).
 * Never fails the run: the tests have already reported their verdict.
 */
export default async function globalTeardown(): Promise<void> {
  const config = performanceConfig();
  if (!config) return;

  if (config.keepDatabase) {
    process.stdout.write(
      `\nPerformance harness: INTEGRATION_KEEP_DATABASES=true, leaving ` +
        `${config.databaseName} in place\n`,
    );
    return;
  }

  try {
    const admin = await openAdminConnection({
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
    });
    try {
      await admin.drop(config.databaseName);
    } finally {
      await admin.close();
    }
  } catch (error) {
    process.stdout.write(
      `\nPerformance harness: teardown could not drop ${config.databaseName} ` +
        `(${error instanceof Error ? error.message : "unknown error"}). ` +
        `The next run drops it during setup.\n`,
    );
  }
}
