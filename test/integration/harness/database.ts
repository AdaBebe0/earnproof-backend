import { PrismaClient } from "@prisma/client";
import { withDeadline } from "./bounded";
import { IntegrationConfig, integrationConfig } from "./config";
import { openAdminConnection } from "./admin";
import { redactErrorInPlace } from "./redaction";

/**
 * Per-worker database lifecycle.
 *
 * Isolation model, and why this one:
 *
 * - **One database per Jest worker**, cloned from a template that global setup
 *   migrated once. `CREATE DATABASE ... TEMPLATE` is a file copy inside
 *   PostgreSQL, so a worker gets a fully migrated schema in milliseconds
 *   without replaying eleven migrations. Workers never share a database, so
 *   `--maxWorkers` can be raised without tests colliding.
 *
 * - **Truncate between tests**, not "wrap each test in a rolled-back
 *   transaction". The transaction trick is faster, but it makes the code under
 *   test run inside a transaction that it did not open — which silently breaks
 *   every test of transaction behaviour, and this suite exists largely to test
 *   transaction behaviour. Truncation costs a few milliseconds on empty tables
 *   and leaves `$transaction` meaning what it means in production.
 *
 * A worker's database is created lazily on first use and reused by every test
 * file that worker runs. Jest gives each test file a fresh module registry, so
 * the cache below is per-file; the existence check makes the second file's
 * "create" a no-op rather than a failure.
 */

/** Tables the harness must not truncate: Prisma's own migration ledger. */
const PRESERVED_TABLES = new Set(["_prisma_migrations"]);

export interface IntegrationDatabase {
  /** Prisma client bound to this worker's database, with errors redacted. */
  readonly prisma: PrismaClient;
  /** Empties every application table. Called automatically before each test. */
  reset(): Promise<void>;
}

/**
 * Wraps a Prisma client so that every rejection is redacted before it escapes.
 *
 * This is the highest-value redaction point in the harness. Prisma builds its
 * error messages from the datasource and the failing query, so an unreachable
 * database prints the connection string with its password, and a constraint
 * violation can print the row that violated it. Catching at the client boundary
 * covers every test without any of them having to remember.
 *
 * The error object itself is mutated rather than replaced, so `instanceof` and
 * `error.code` keep working — tests assert on `P2002`.
 */
function withRedactedErrors(client: PrismaClient): PrismaClient {
  /** Wraps one callable so a rejection is redacted on the way out. */
  const guard =
    (operation: (...a: unknown[]) => unknown, self: object) =>
    (...args: unknown[]) => {
      try {
        const result = operation.apply(self, args);
        return result instanceof Promise
          ? result.catch((error: unknown) => {
              throw redactErrorInPlace(error);
            })
          : result;
      } catch (error) {
        throw redactErrorInPlace(error);
      }
    };

  /**
   * A model delegate, as opposed to one of the client's internals.
   *
   * Identified by shape rather than by name. Wrapping every object property
   * would also wrap Prisma's private state — engine handles, extension
   * registries — whose internals are not proxy-safe, and the failure would be
   * a confusing one somewhere far from here.
   */
  const isModelDelegate = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).findMany === "function";

  return new Proxy(client, {
    get(target, property) {
      // `target` is passed as the receiver rather than the proxy: Prisma's
      // delegates are produced by getters that key internal state off `this`.
      const value = Reflect.get(target, property, target);

      if (typeof value === "function") {
        return guard(value as (...a: unknown[]) => unknown, target);
      }

      if (isModelDelegate(value)) {
        return new Proxy(value, {
          get(delegate, method) {
            const operation = Reflect.get(delegate, method, delegate);
            return typeof operation === "function"
              ? guard(operation as (...a: unknown[]) => unknown, delegate)
              : operation;
          },
        });
      }

      return value;
    },
  }) as PrismaClient;
}

let cachedClient: PrismaClient | undefined;
let cachedTruncateStatement: string | undefined;

/** Creates this worker's database from the template if it is not already there. */
async function ensureWorkerDatabase(config: IntegrationConfig): Promise<void> {
  const admin = await openAdminConnection(config);
  try {
    if (await admin.exists(config.workerName)) return;
    await admin.create(config.workerName, { template: config.templateName });
  } finally {
    await admin.close();
  }
}

async function connect(config: IntegrationConfig): Promise<PrismaClient> {
  if (cachedClient) return cachedClient;

  await ensureWorkerDatabase(config);

  const client = new PrismaClient({ datasourceUrl: config.workerUrl });
  await withDeadline(
    "Connecting to the worker database",
    config.adminTimeoutMs,
    () => client.$connect(),
  );

  cachedClient = client;
  return client;
}

/**
 * Builds the single `TRUNCATE` that empties every application table.
 *
 * One statement rather than one per table: `TRUNCATE a, b, c CASCADE` takes the
 * locks in one go, so it cannot deadlock against itself, and it does not care
 * about foreign-key order — which would otherwise have to be maintained by hand
 * every time a relation is added.
 *
 * The table list is read from the database instead of from `schema.prisma`, so
 * a table added by a migration is truncated without anyone updating this file.
 */
async function truncateStatement(client: PrismaClient): Promise<string> {
  if (cachedTruncateStatement) return cachedTruncateStatement;

  const rows = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.has(name));

  if (tables.length === 0) {
    throw new Error(
      "The worker database has no application tables. The template was cloned " +
        "before migrations finished, or migrations produced an empty schema.",
    );
  }

  cachedTruncateStatement = `TRUNCATE TABLE ${tables
    .map((name) => `"public"."${name}"`)
    .join(", ")} RESTART IDENTITY CASCADE`;

  return cachedTruncateStatement;
}

/**
 * Registers the database lifecycle for one test file and returns a handle.
 *
 * Usage:
 *
 * ```ts
 * const db = integrationDatabase();
 * it("…", async () => { await db.prisma.user.create({ … }); });
 * ```
 *
 * The handle is returned before the client exists — `beforeAll` fills it in.
 * Reading `db.prisma` from module scope therefore throws with an explanation
 * rather than yielding `undefined` and failing somewhere less obvious.
 */
export function integrationDatabase(): IntegrationDatabase {
  const config = integrationConfig();
  let client: PrismaClient | undefined;

  const reset = async (): Promise<void> => {
    if (!client) return;
    const statement = await truncateStatement(client);
    await withDeadline("Truncating the worker database", config.adminTimeoutMs, () =>
      client!.$executeRawUnsafe(statement),
    );
  };

  beforeAll(async () => {
    client = withRedactedErrors(await connect(config));
    await reset();
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    // The client is cached for the whole worker process, but each test file
    // must leave the connection closed: Jest reports an open handle as a leak,
    // and a lingering session blocks the `DROP DATABASE` in global teardown.
    if (cachedClient) {
      await withDeadline(
        "Disconnecting from the worker database",
        config.adminTimeoutMs,
        () => cachedClient!.$disconnect(),
      );
      cachedClient = undefined;
      cachedTruncateStatement = undefined;
    }
    client = undefined;
  });

  return {
    get prisma(): PrismaClient {
      if (!client) {
        throw new Error(
          "The integration database is only available inside a test or hook. " +
            "integrationDatabase() connects in beforeAll, so module-scope access is too early.",
        );
      }
      return client;
    },
    reset,
  };
}
