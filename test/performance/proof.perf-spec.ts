import {
  performanceDatabaseAvailable,
  performanceDatabase,
} from "./harness/client";
import { explainQuery } from "./harness/explain";
import { PROOF_LIST_DEEP_PAGE_BUDGET } from "./budgets";

/**
 * Proof: cursor-paginated proof history, at depth.
 *
 * Mirrors the query `ProofsService#listProofs`
 * (src/proofs/proofs.service.ts, ~line 308) issues for a cursor page:
 *
 *   this.prisma.proof.findMany({
 *     where: { userId, ... },
 *     orderBy: [{ createdAt: "desc" }, { id: "desc" }],
 *     take: limit + 1,
 *     cursor: { id: cursorId },
 *     skip: 1,
 *   })
 *
 * Should use `Proof.@@index([userId, createdAt, id])`. Run at a deep cursor
 * position (page ~40 of 20) against a heavy user (1,200 proofs seeded), not
 * page 1 — a plan that looks fine on the first page can still degrade with
 * depth if the cursor comparison does not use the index the way Prisma's
 * `(createdAt, id) < (cursorCreatedAt, cursorId)` translation expects.
 */
describe("proof: listProofs deep cursor page", () => {
  let skip = false;
  let cursorId: string | undefined;
  let cursorCreatedAt: Date | undefined;

  beforeAll(async () => {
    skip = !(await performanceDatabaseAvailable());
    if (skip) {
      console.warn(
        "Skipping proof.perf-spec.ts: TEST_DATABASE_URL is not set or " +
          "PostgreSQL is unreachable. See docs/database-performance.md.",
      );
      return;
    }

    const db = performanceDatabase();
    // Position a cursor ~40 pages in (20 rows/page) by walking the same
    // order the service uses, then taking the 800th row as the cursor.
    const rows = await db.prisma.proof.findMany({
      where: { userId: "synthetic_perf_heavy_user_0" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
      skip: 800,
      select: { id: true, createdAt: true },
    });
    cursorId = rows[0]?.id;
    cursorCreatedAt = rows[0]?.createdAt;
  });

  it(PROOF_LIST_DEEP_PAGE_BUDGET.name, async () => {
    if (skip) return;
    if (!cursorId || !cursorCreatedAt) {
      throw new Error(
        "Fixture did not produce a deep-page cursor; scale-seed.ts's " +
          "proofsPerHeavyUser must stay above 800 for this test to be meaningful.",
      );
    }
    const db = performanceDatabase();

    // Mirrors Prisma's cursor + skip:1 translation: strictly-less-than on
    // the (createdAt, id) tuple, ordered the same way, limited to a page.
    const summary = await explainQuery(
      db.prisma,
      `SELECT * FROM "Proof"
        WHERE "userId" = $1
          AND ("createdAt", "id") < ($2, $3)
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 21`,
      ["synthetic_perf_heavy_user_0", cursorCreatedAt, cursorId],
    );

    expect(summary.seqScannedRelations.has("Proof")).toBe(false);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      PROOF_LIST_DEEP_PAGE_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      PROOF_LIST_DEEP_PAGE_BUDGET.maxTotalCost,
    );
  });

  it("uses the userId+createdAt+id composite index, not a bare userId or status index", async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT * FROM "Proof"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 21`,
      ["synthetic_perf_heavy_user_0"],
    );

    expect(summary.seqScannedRelations.has("Proof")).toBe(false);
    expect(
      [...summary.indexesUsed].some((name) => /userId_createdAt_id/i.test(name)),
    ).toBe(true);
  });
});
