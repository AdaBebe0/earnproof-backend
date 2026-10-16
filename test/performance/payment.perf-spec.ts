import {
  performanceDatabaseAvailable,
  performanceDatabase,
} from "./harness/client";
import { explainQuery } from "./harness/explain";
import { PAYMENT_LIST_BUDGET } from "./budgets";

/**
 * Payment: filtered, sorted payment history.
 *
 * Mirrors the exact query `PaymentsService#listPayments`
 * (src/payments/payments.service.ts, ~line 133) issues:
 *
 *   this.prisma.payment.findMany({
 *     where: { userId, classification, assetCode },
 *     orderBy: { occurredAt: "desc" },
 *     take: 100,
 *   })
 *
 * Should use `Payment.@@index([userId, occurredAt])`. Run against a heavy
 * user (6,000 payments seeded by scale-seed.ts) so the planner has a real
 * choice to make between that index and a sequential scan.
 */
describe("payment: listPayments", () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await performanceDatabaseAvailable());
    if (skip) {
      console.warn(
        "Skipping payment.perf-spec.ts: TEST_DATABASE_URL is not set or " +
          "PostgreSQL is unreachable. See docs/database-performance.md.",
      );
    }
  });

  it(PAYMENT_LIST_BUDGET.name, async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT * FROM "Payment"
        WHERE "userId" = $1
        ORDER BY "occurredAt" DESC
        LIMIT 100`,
      ["synthetic_perf_heavy_user_0"],
    );

    expect(summary.seqScannedRelations.has("Payment")).toBe(false);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      PAYMENT_LIST_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      PAYMENT_LIST_BUDGET.maxTotalCost,
    );
  });

  it("filtered by classification and assetCode still avoids a full scan", async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT * FROM "Payment"
        WHERE "userId" = $1 AND "classification" = $2 AND "assetCode" = $3
        ORDER BY "occurredAt" DESC
        LIMIT 100`,
      ["synthetic_perf_heavy_user_0", "INCOME", "USDC"],
    );

    expect(summary.seqScannedRelations.has("Payment")).toBe(false);
  });

  it("has no unbounded scan: cost stays governed by the (userId, occurredAt) index, not table size", async () => {
    if (skip) return;
    const db = performanceDatabase();

    // Same shape without LIMIT, to make sure the bound comes from the WHERE
    // clause matching a narrow slice of the index rather than from LIMIT
    // alone — a regression that dropped the userId filter would still look
    // bounded here only by accident, so this asserts on the index used.
    const summary = await explainQuery(
      db.prisma,
      `SELECT * FROM "Payment" WHERE "userId" = $1 ORDER BY "occurredAt" DESC`,
      ["synthetic_perf_regular_user_0"],
    );

    expect(summary.seqScannedRelations.has("Payment")).toBe(false);
    expect(
      [...summary.indexesUsed].some((name) => /userId/i.test(name)),
    ).toBe(true);
  });
});
