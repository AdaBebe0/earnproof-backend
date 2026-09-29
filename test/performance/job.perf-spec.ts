import {
  performanceDatabaseAvailable,
  performanceDatabase,
} from "./harness/client";
import { explainQuery } from "./harness/explain";
import {
  WEBHOOK_RETRY_SWEEP_BUDGET,
  WALLET_CHALLENGE_EXPIRY_SWEEP_BUDGET,
} from "./budgets";

/**
 * Job / scheduled-task queries.
 *
 * Two queries, both run unattended (no request in flight to notice if they
 * slow down) and both scan a meaningful slice of their table by design:
 *
 * 1. `WebhookDeliveryService#onModuleInit` retry sweep
 *    (src/webhooks/webhook-delivery.service.ts, ~line 69):
 *
 *      this.prisma.webhookDelivery.findMany({
 *        where: { status: WebhookDeliveryStatus.PENDING },
 *        orderBy: { createdAt: "asc" },
 *      })
 *
 *    Should use `WebhookDelivery.@@index([status, nextRetryAt])`.
 *
 * 2. `CleanupJob#cleanupChallenges` phase 1 expiry sweep
 *    (src/auth/cleanup.job.ts, ~line 78), which runs daily via
 *    `AUTH_CHALLENGE_CLEANUP_CRON`:
 *
 *      this.prisma.walletChallenge.deleteMany({ where: { expiresAt: { lt: now } } })
 *
 *    Should use `WalletChallenge.@@index([expiresAt])`. Explained as a
 *    SELECT with the same WHERE clause: EXPLAIN ANALYZE on a DELETE
 *    actually deletes rows, which would corrupt the shared fixture for
 *    every other test in this suite.
 */
describe("job: scheduled sweep queries", () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await performanceDatabaseAvailable());
    if (skip) {
      console.warn(
        "Skipping job.perf-spec.ts: TEST_DATABASE_URL is not set or " +
          "PostgreSQL is unreachable. See docs/database-performance.md.",
      );
    }
  });

  it(WEBHOOK_RETRY_SWEEP_BUDGET.name, async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT "id", "webhookId", "attempt", "nextRetryAt"
         FROM "WebhookDelivery"
        WHERE "status" = 'PENDING'
        ORDER BY "createdAt" ASC`,
    );

    expect(summary.seqScannedRelations.has("WebhookDelivery")).toBe(false);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      WEBHOOK_RETRY_SWEEP_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      WEBHOOK_RETRY_SWEEP_BUDGET.maxTotalCost,
    );
  });

  it(WALLET_CHALLENGE_EXPIRY_SWEEP_BUDGET.name, async () => {
    if (skip) return;
    const db = performanceDatabase();

    // Mirrors deleteMany's WHERE clause without mutating the shared fixture.
    const summary = await explainQuery(
      db.prisma,
      `SELECT "id" FROM "WalletChallenge" WHERE "expiresAt" < now()`,
    );

    expect(summary.seqScannedRelations.has("WalletChallenge")).toBe(false);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      WALLET_CHALLENGE_EXPIRY_SWEEP_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      WALLET_CHALLENGE_EXPIRY_SWEEP_BUDGET.maxTotalCost,
    );
  });

  it("webhook retry sweep uses the (status, nextRetryAt) composite index", async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT "id" FROM "WebhookDelivery" WHERE "status" = 'PENDING'`,
    );

    expect(
      [...summary.indexesUsed].some((name) => /status_nextRetryAt/i.test(name)),
    ).toBe(true);
  });
});
