import { PrismaClient } from "@prisma/client";
import {
  assertResetAllowed,
  databaseNameFromUrl,
  resetDatabase,
} from "../src/testing/reset/database-reset";

/**
 * Destructive reset: empties every application table in the target database.
 *
 * Run with:
 *   CONFIRM_RESET=<database name> npm run db:reset
 *
 * The schema is left in place — this truncates, it does not drop — so the
 * database stays at its current migration and can be re-seeded immediately.
 *
 * The guard runs before a client is constructed. It refuses production
 * outright, refuses an unknown or non-disposable target, and requires the
 * operator to name the database being emptied. See
 * `src/testing/reset/database-reset.ts` for why naming the target is the check
 * that matters.
 */
async function main(): Promise<void> {
  assertResetAllowed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    confirmDatabase: process.env.CONFIRM_RESET,
    allowOverride: process.env.ALLOW_DESTRUCTIVE_RESET,
  });

  const databaseName = databaseNameFromUrl(process.env.DATABASE_URL ?? "");
  const prisma = new PrismaClient();

  try {
    const { tables, rowsBefore } = await resetDatabase(prisma);
    const removed = Object.values(rowsBefore).reduce((sum, n) => sum + n, 0);

    // Reported per table, and only as counts: what was destroyed has to be
    // legible afterwards, and none of it may end up in a terminal scrollback as
    // record content.
    console.log(`Reset "${databaseName}": ${tables.length} tables, ${removed} rows removed.`);
    for (const table of tables) {
      if (rowsBefore[table] > 0) console.log(`  - ${table}: ${rowsBefore[table]}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
