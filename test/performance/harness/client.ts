import { PrismaClient } from "@prisma/client";
import { performanceConfig } from "./config";

/**
 * Per-test-file connection to the shared, pre-seeded performance database.
 *
 * Unlike `test/integration/harness/database.ts`, this does not create,
 * truncate, or own the database's lifecycle — `global-setup.ts` already
 * built and seeded it once for the whole run, and every `*.perf-spec.ts`
 * file reads from the same fixture. Call `performanceDatabase()` at module
 * scope and use the returned handle inside `beforeAll`/`it`.
 *
 * `available` is resolved once connecting is attempted; a test file checks
 * it before its first `it` and calls `describe.skip` when false, which is
 * how the suite degrades to "skipped" rather than "failed" when
 * `TEST_DATABASE_URL` is unset or PostgreSQL is unreachable — see
 * docs/database-performance.md.
 */
export interface PerformanceDatabase {
  readonly prisma: PrismaClient;
}

let cachedClient: PrismaClient | undefined;
let cachedAvailability: boolean | undefined;

/**
 * Resolves whether the performance database is reachable, connecting once
 * and caching the result for the rest of the process.
 */
export async function performanceDatabaseAvailable(): Promise<boolean> {
  if (cachedAvailability !== undefined) return cachedAvailability;

  const config = performanceConfig();
  if (!config) {
    cachedAvailability = false;
    return false;
  }

  try {
    const client = new PrismaClient({ datasourceUrl: config.databaseUrl });
    await client.$connect();
    // A cheap query confirms the seeded schema is actually there, not just
    // that some database accepted the connection.
    await client.user.count();
    cachedClient = client;
    cachedAvailability = true;
    return true;
  } catch {
    cachedAvailability = false;
    return false;
  }
}

/**
 * Registers the database handle for one test file.
 *
 * Must be called after a truthy `performanceDatabaseAvailable()` check —
 * typically inside the `describe` block's own guard — since it throws if the
 * database was never reachable.
 */
export function performanceDatabase(): PerformanceDatabase {
  return {
    get prisma(): PrismaClient {
      if (!cachedClient) {
        throw new Error(
          "The performance database is not connected. Call and await " +
            "performanceDatabaseAvailable() before performanceDatabase().",
        );
      }
      return cachedClient;
    },
  };
}

/** Disconnects the shared client. Call once, in `afterAll` of the last file needing it. */
export async function closePerformanceDatabase(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = undefined;
    cachedAvailability = undefined;
  }
}
