import { PrismaClient } from "@prisma/client";
import { withDeadline } from "./bounded";
import { IntegrationConfig, integrationConfig } from "./config";

/**
 * Administrative database operations, performed over the maintenance database.
 *
 * These are the only statements in the harness that are not addressed to a test
 * database, and the only ones that interpolate an identifier. Every name
 * reaching this module has already been validated against
 * `config.ts`'s identifier pattern, and is quoted here as well — the pattern
 * makes injection impossible, the quoting makes it obvious.
 *
 * The Prisma client is used rather than a second PostgreSQL driver so the
 * harness has exactly one way of reaching the database. Adding `pg` alongside
 * Prisma would mean two connection stacks with two failure modes and two sets
 * of TLS behaviour to keep aligned.
 */

/** DDL cannot be parameterised, so identifiers are quoted after validation. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export interface AdminConnection {
  exists(databaseName: string): Promise<boolean>;
  create(databaseName: string, options?: { template?: string }): Promise<void>;
  drop(databaseName: string): Promise<void>;
  listDatabases(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Opens a connection to the maintenance database.
 *
 * Bounded, because "cannot reach PostgreSQL" and "PostgreSQL accepted the
 * socket and went quiet" are indistinguishable to a caller that waits forever.
 */
export async function openAdminConnection(
  config: IntegrationConfig = integrationConfig(),
): Promise<AdminConnection> {
  const client = new PrismaClient({ datasourceUrl: config.maintenanceUrl });

  await withDeadline("Connecting to the maintenance database", config.adminTimeoutMs, () =>
    client.$connect(),
  );

  const run = <T>(label: string, operation: () => Promise<T>) =>
    withDeadline(label, config.adminTimeoutMs, operation);

  /**
   * Forces every other session off a database.
   *
   * `CREATE DATABASE ... TEMPLATE` and `DROP DATABASE` both fail while any
   * other backend is connected. In CI that other backend is usually a worker
   * whose client had not finished disconnecting; without this the run fails
   * intermittently and looks like flakiness rather than a race.
   */
  const disconnectSessions = (databaseName: string) =>
    run(`Terminating sessions on ${databaseName}`, () =>
      client.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        databaseName,
      ),
    );

  return {
    async exists(databaseName: string): Promise<boolean> {
      const rows = await run(`Checking whether ${databaseName} exists`, () =>
        client.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::bigint AS count FROM pg_database WHERE datname = $1`,
          databaseName,
        ),
      );
      return Number(rows[0]?.count ?? 0) > 0;
    },

    async create(databaseName, options = {}): Promise<void> {
      if (options.template) {
        await disconnectSessions(options.template);
      }

      const statement = options.template
        ? `CREATE DATABASE ${quote(databaseName)} TEMPLATE ${quote(options.template)}`
        : `CREATE DATABASE ${quote(databaseName)}`;

      try {
        await run(`Creating database ${databaseName}`, () =>
          client.$executeRawUnsafe(statement),
        );
      } catch (error) {
        // 42P04 = duplicate_database. Two workers can reach this line at the
        // same instant; the loser should proceed with the database the winner
        // created rather than fail the whole suite.
        if (!isDuplicateDatabase(error)) throw error;
      }
    },

    async drop(databaseName: string): Promise<void> {
      await disconnectSessions(databaseName);
      await run(`Dropping database ${databaseName}`, () =>
        client.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)}`),
      );
    },

    async listDatabases(prefix: string): Promise<string[]> {
      const rows = await run(`Listing databases matching ${prefix}`, () =>
        client.$queryRawUnsafe<Array<{ datname: string }>>(
          `SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
          `${prefix}%`,
        ),
      );
      return rows.map((row) => row.datname);
    },

    async close(): Promise<void> {
      await withDeadline(
        "Closing the maintenance connection",
        config.adminTimeoutMs,
        () => client.$disconnect(),
      );
    },
  };
}

function isDuplicateDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("42P04") || /already exists/i.test(message);
}
