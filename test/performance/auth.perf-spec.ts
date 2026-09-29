import {
  performanceDatabaseAvailable,
  performanceDatabase,
} from "./harness/client";
import { explainQuery } from "./harness/explain";
import { AUTH_SESSION_VALIDATE_BUDGET } from "./budgets";

/**
 * Auth: session token validation.
 *
 * Mirrors the exact query `SessionService#validate`
 * (src/auth/session.service.ts) issues:
 *
 *   this.prisma.authSession.findUnique({ where: { tokenHash } })
 *
 * `tokenHash` carries `@unique` in schema.prisma, so PostgreSQL should
 * always resolve this via an index (or index-only) scan — this is the
 * query every authenticated request runs, so a regression to a sequential
 * scan here degrades the whole API, not one endpoint.
 */
describe("auth: session token lookup", () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await performanceDatabaseAvailable());
    if (skip) {
      console.warn(
        "Skipping auth.perf-spec.ts: TEST_DATABASE_URL is not set or " +
          "PostgreSQL is unreachable. See docs/database-performance.md.",
      );
    }
  });

  it(AUTH_SESSION_VALIDATE_BUDGET.name, async () => {
    if (skip) return;
    const db = performanceDatabase();

    // A session tokenHash seeded by scale-seed.ts's buildable pattern.
    const summary = await explainQuery(
      db.prisma,
      `SELECT "id", "userId", "expiresAt", "revokedAt" FROM "AuthSession" WHERE "tokenHash" = $1 LIMIT 1`,
      ["sha256:synthetic-perf-session-0-0"],
    );

    expect(summary.seqScannedRelations.has("AuthSession")).toBe(false);
    expect(
      [...summary.nodeTypes].some((type) =>
        /Index (Only )?Scan/.test(type),
      ),
    ).toBe(true);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      AUTH_SESSION_VALIDATE_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      AUTH_SESSION_VALIDATE_BUDGET.maxTotalCost,
    );
  });

  it("does not degrade to a sequential scan when the session is missing", async () => {
    if (skip) return;
    const db = performanceDatabase();

    // A miss must still resolve via the unique index — a naive rewrite of
    // this query (e.g. adding a non-indexed filter) tends to only show up
    // as a seq scan on the miss path first.
    const summary = await explainQuery(
      db.prisma,
      `SELECT "id" FROM "AuthSession" WHERE "tokenHash" = $1 LIMIT 1`,
      ["sha256:does-not-exist"],
    );

    expect(summary.seqScannedRelations.has("AuthSession")).toBe(false);
  });
});
