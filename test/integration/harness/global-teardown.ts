import { openAdminConnection } from "./admin";
import { integrationConfig } from "./config";

/**
 * Drops every database the run created.
 *
 * Worker databases are discovered by prefix rather than tracked, because global
 * teardown runs in a different process from the workers and cannot be told what
 * they created. The prefix comes from the validated naming base, so this can
 * only ever match databases the harness owns.
 *
 * Teardown never fails the run. The tests have already reported their verdict;
 * turning "a database could not be dropped" into a red build would report a
 * cleanup problem as a test failure, and the next run's setup drops the
 * leftovers anyway.
 */
export default async function globalTeardown(): Promise<void> {
  const config = integrationConfig();

  if (config.keepDatabases) {
    process.stdout.write(
      `\nIntegration harness: INTEGRATION_KEEP_DATABASES=true, leaving ` +
        `${config.templateName} and ${config.workerPrefix}* in place\n`,
    );
    return;
  }

  try {
    const admin = await openAdminConnection(config);
    try {
      for (const name of await admin.listDatabases(config.workerPrefix)) {
        await admin.drop(name);
      }
      await admin.drop(config.templateName);
    } finally {
      await admin.close();
    }
  } catch (error) {
    // Already redacted by the bounded-operation wrapper.
    process.stdout.write(
      `\nIntegration harness: teardown could not drop its databases ` +
        `(${error instanceof Error ? error.message : "unknown error"}). ` +
        `The next run drops them during setup.\n`,
    );
  }
}
