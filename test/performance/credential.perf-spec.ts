import {
  performanceDatabaseAvailable,
  performanceDatabase,
} from "./harness/client";
import { explainQuery } from "./harness/explain";
import { CREDENTIAL_VERIFY_LOOKUP_BUDGET } from "./budgets";

/**
 * Credential: verification-time proof lookup.
 *
 * Mirrors the exact query `CredentialsService#verifyCredential`
 * (src/credentials/credentials.service.ts, ~line 195) issues:
 *
 *   this.prisma.proof.findUnique({ where: { credentialHash } })
 *
 * `credentialHash` carries `@unique`. This is the public, unauthenticated
 * verification endpoint (docs/adr/0004-public-unauthenticated-verification.md),
 * so it is the query most exposed to being hammered by a caller outside the
 * organization's control — a regression to a sequential scan here is a
 * denial-of-service surface, not just a slow page.
 */
describe("credential: verifyCredential lookup", () => {
  let skip = false;
  let sampleCredentialHash: string | undefined;

  beforeAll(async () => {
    skip = !(await performanceDatabaseAvailable());
    if (skip) {
      console.warn(
        "Skipping credential.perf-spec.ts: TEST_DATABASE_URL is not set or " +
          "PostgreSQL is unreachable. See docs/database-performance.md.",
      );
      return;
    }

    // credentialHash values are derived from a SHA-256 digest (see
    // syntheticCredentialHash in src/testing/factories/synthetic.ts), so
    // there is no readable literal to hardcode — read one real seeded value
    // back instead. This lookup is not part of the timed query.
    const db = performanceDatabase();
    const sample = await db.prisma.proof.findFirst({
      where: { userId: "synthetic_perf_heavy_user_0" },
      select: { credentialHash: true },
    });
    sampleCredentialHash = sample?.credentialHash;
  });

  it(CREDENTIAL_VERIFY_LOOKUP_BUDGET.name, async () => {
    if (skip) return;
    if (!sampleCredentialHash) {
      throw new Error(
        "Fixture did not produce a sample Proof row for synthetic_perf_heavy_user_0",
      );
    }
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT "id", "status", "expiresAt", "schemaVersion", "contractTransactionHash"
         FROM "Proof" WHERE "credentialHash" = $1 LIMIT 1`,
      [sampleCredentialHash],
    );

    expect(summary.seqScannedRelations.has("Proof")).toBe(false);
    expect(
      [...summary.nodeTypes].some((type) => /Index (Only )?Scan/.test(type)),
    ).toBe(true);
    expect(summary.executionTimeMs).toBeLessThanOrEqual(
      CREDENTIAL_VERIFY_LOOKUP_BUDGET.maxExecutionTimeMs,
    );
    expect(summary.totalCost).toBeLessThanOrEqual(
      CREDENTIAL_VERIFY_LOOKUP_BUDGET.maxTotalCost,
    );
  });

  it("a miss (unknown credential) still resolves via the unique index", async () => {
    if (skip) return;
    const db = performanceDatabase();

    const summary = await explainQuery(
      db.prisma,
      `SELECT "id" FROM "Proof" WHERE "credentialHash" = $1 LIMIT 1`,
      ["sha256:not-a-real-credential"],
    );

    expect(summary.seqScannedRelations.has("Proof")).toBe(false);
  });
});
