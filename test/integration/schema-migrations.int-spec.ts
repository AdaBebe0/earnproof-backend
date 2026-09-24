import { integrationDatabase } from "./harness/database";
import { integrationConfig } from "./harness/config";
import { assertNoSchemaDrift, migrationDirectoryNames } from "./harness/migrate";
import { nonEmptyTables } from "./harness/fixtures";
import { seedUser } from "./harness/fixtures";

/**
 * The harness's own contract.
 *
 * Everything else in this directory assumes three things: the schema came from
 * the production migrations, the migrations match `schema.prisma`, and each
 * test starts from an empty database. Those assumptions are load-bearing — a
 * harness that silently stops isolating turns a suite into a source of
 * confident wrong answers — so they are asserted rather than trusted.
 */

const db = integrationDatabase();

describe("migrations applied from an empty database", () => {
  it("records every migration in prisma/migrations as applied", async () => {
    const expected = migrationDirectoryNames();
    expect(expected.length).toBeGreaterThan(0);

    const rows = await db.prisma.$queryRaw<
      Array<{ migration_name: string; rolled_back_at: Date | null }>
    >`
      SELECT migration_name, rolled_back_at
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL
    `;

    expect(rows.map((row) => row.migration_name).sort()).toEqual(expected);
    expect(rows.every((row) => row.rolled_back_at === null)).toBe(true);
  });

  it("produces the schema that prisma/schema.prisma describes", async () => {
    // The check `migrate deploy` cannot make on its own: a model edited without
    // a matching migration still generates a working client, so every unit test
    // passes while production is one release away from a missing column.
    await expect(
      assertNoSchemaDrift(integrationConfig().workerUrl, integrationConfig()),
    ).resolves.toBeUndefined();
  });

  it("creates the enum types the domain depends on", async () => {
    const rows = await db.prisma.$queryRaw<Array<{ typname: string }>>`
      SELECT typname FROM pg_type WHERE typtype = 'e'
    `;

    const enums = rows.map((row) => row.typname);
    expect(enums).toEqual(
      expect.arrayContaining([
        "UserRole",
        "ResourceStatus",
        "ProofStatus",
        "ProofType",
        "PaymentClassification",
        "WebhookDeliveryStatus",
        "AnchoringStatus",
      ]),
    );
  });

  it("creates the unique constraints the application relies on", async () => {
    const rows = await db.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;

    const indexes = rows.map((row) => row.indexname);

    // Named explicitly because each one is an invariant some test below
    // depends on: without the index, the "constraint violation" tests would
    // pass by writing duplicates and never noticing.
    expect(indexes).toEqual(
      expect.arrayContaining([
        "Payment_operationId_key",
        "Proof_credentialHash_key",
        "AuthSession_tokenHash_key",
        "AuthSession_rotatedToId_key",
        "WebhookDelivery_replayKey_key",
        "AnchoringIntent_proofId_operation_key",
        "TrustedSource_userId_sourceAddress_key",
      ]),
    );
  });
});

describe("isolation between tests", () => {
  it("starts from an empty database", async () => {
    expect(await nonEmptyTables(db.prisma)).toEqual([]);
  });

  it("writes rows that the next test must not see", async () => {
    await seedUser(db.prisma, "isolation-probe");
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("still starts from an empty database after the previous test wrote", async () => {
    // This is the assertion that makes repeated runs meaningful. If truncation
    // ever stops happening, this fails here rather than as an unexplained
    // unique-constraint error in an unrelated suite.
    expect(await nonEmptyTables(db.prisma)).toEqual([]);
  });

  it("can reseed the same deterministic fixture without colliding", async () => {
    // The factories produce stable ids on purpose. Reseeding the same id only
    // works because the previous test's row is gone.
    const user = await seedUser(db.prisma, "isolation-probe");
    expect(user.id).toBe("synthetic_user_isolation-probe");
  });

  it("preserves the migration ledger across truncation", async () => {
    // Truncating `_prisma_migrations` would leave a database that looks
    // unmigrated to the next `migrate deploy`, so it is explicitly excluded.
    const rows = await db.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM _prisma_migrations
    `;
    expect(Number(rows[0].count)).toBe(migrationDirectoryNames().length);
  });
});

describe("worker isolation", () => {
  it("runs against a database owned by this worker alone", () => {
    const config = integrationConfig();
    const workerId = process.env.JEST_WORKER_ID ?? "1";

    expect(config.workerName).toBe(`${config.baseName}_w${workerId}`);
    expect(config.workerName).not.toBe(config.baseName);
    expect(config.workerName).not.toBe(config.templateName);
  });
});
