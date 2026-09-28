import {
  AnchoringOperation,
  AnchoringStatus,
  ProofStatus,
  ProofType,
} from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  nonEmptyTables,
  seedProof,
  seedUser,
} from "./harness/fixtures";

/**
 * Transaction semantics.
 *
 * Every write path in this service that touches more than one table does so
 * inside `prisma.$transaction`: proof issuance writes `Proof`, `ProofClaim` and
 * optionally `AnchoringIntent`; session rotation creates the replacement and
 * revokes the original. Each of those is only safe because a failure anywhere
 * discards the whole thing.
 *
 * A mocked Prisma client cannot express that. `$transaction` is stubbed to call
 * its callback, so a test passes whether the writes are atomic or not — and the
 * failure it would have caught is the worst kind: a half-issued proof, or a
 * session revoked with no replacement, both of which look like data corruption
 * rather than a bug.
 *
 * This file therefore asserts commit, rollback, and the constraint violations
 * that trigger rollback, against a real transactional database.
 */

const db = integrationDatabase();

/** Marker error, so a rollback test cannot pass because of an unrelated failure. */
class DeliberateFailure extends Error {
  constructor() {
    super("deliberate failure to force a rollback");
    this.name = "DeliberateFailure";
  }
}

describe("successful transactions", () => {
  it("commits every write in an interactive transaction", async () => {
    const user = await seedUser(db.prisma, "tx-commit");

    const proof = await db.prisma.$transaction(async (tx) => {
      const created = await tx.proof.create({
        data: {
          userId: user.id,
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          network: "testnet",
          assetCode: "USDC",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          credentialHash: "sha256:synthetic-tx-commit",
          claim: {
            create: {
              operator: "gte",
              result: true,
              disclosurePolicy: { exactIncomeHidden: true },
            },
          },
        },
      });

      await tx.anchoringIntent.create({
        data: {
          proofId: created.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      return created;
    });

    // This is the shape proof issuance produces: three rows, all present.
    expect(await db.prisma.proof.count()).toBe(1);
    expect(await db.prisma.proofClaim.count({ where: { proofId: proof.id } })).toBe(1);
    expect(
      await db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
    ).toBe(1);
  });

  it("commits a sequential batch transaction", async () => {
    const user = await seedUser(db.prisma, "tx-batch");
    const proof = await seedProof(db.prisma, "tx-batch-proof", user.id);

    await db.prisma.$transaction([
      db.prisma.proof.update({
        where: { id: proof.id },
        data: { status: ProofStatus.REVOKED, revokedAt: new Date() },
      }),
      db.prisma.auditLog.create({
        data: {
          actorType: "user",
          actorId: user.id,
          action: "proof.revoked",
          resourceType: "proof",
          resourceId: proof.id,
        },
      }),
    ]);

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.status).toBe(ProofStatus.REVOKED);
    expect(await db.prisma.auditLog.count()).toBe(1);
  });

  it("sees its own uncommitted writes inside the transaction", async () => {
    const user = await seedUser(db.prisma, "tx-read-own");

    const seenInside = await db.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: "system",
          action: "probe",
          resourceType: "probe",
        },
      });
      return tx.auditLog.count();
    });

    expect(seenInside).toBe(1);
    expect(await db.prisma.auditLog.count({ where: { actorId: user.id } })).toBe(0);
  });
});

describe("rollback", () => {
  it("discards every write when the callback throws", async () => {
    const user = await seedUser(db.prisma, "tx-rollback");

    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.proof.create({
          data: {
            userId: user.id,
            proofType: ProofType.MINIMUM_INCOME,
            schemaVersion: "earnproof.minimum-income.v1",
            network: "testnet",
            assetCode: "USDC",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            credentialHash: "sha256:synthetic-tx-rollback",
            claim: {
              create: {
                operator: "gte",
                result: true,
                disclosurePolicy: { exactIncomeHidden: true },
              },
            },
          },
        });

        // Fails after the writes, exactly where an anchoring or webhook error
        // would land in the real issuance path.
        throw new DeliberateFailure();
      }),
    ).rejects.toBeInstanceOf(DeliberateFailure);

    expect(await db.prisma.proof.count()).toBe(0);
    expect(await db.prisma.proofClaim.count()).toBe(0);
  });

  it("discards earlier writes when a later one violates a constraint", async () => {
    const user = await seedUser(db.prisma, "tx-constraint-rollback");
    const existing = await seedProof(db.prisma, "tx-existing", user.id);

    const failing = db.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: user.id,
          action: "proof.created",
          resourceType: "proof",
        },
      });

      await tx.proof.create({
        data: {
          userId: user.id,
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          network: "testnet",
          assetCode: "USDC",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          // Collides with the seeded proof.
          credentialHash: existing.credentialHash,
        },
      });
    });

    const error = await failing.catch((thrown: unknown) => thrown);
    expect(isUniqueViolation(error)).toBe(true);

    // The audit entry was written first and must not survive: an audit trail
    // recording an event that never happened is worse than no audit trail.
    expect(await db.prisma.auditLog.count()).toBe(0);
    expect(await db.prisma.proof.count()).toBe(1);
  });

  it("rolls back a sequential batch when any statement fails", async () => {
    const user = await seedUser(db.prisma, "tx-batch-rollback");
    const proof = await seedProof(db.prisma, "tx-batch-rollback-proof", user.id);

    const failing = db.prisma.$transaction([
      db.prisma.proof.update({
        where: { id: proof.id },
        data: { status: ProofStatus.REVOKED },
      }),
      db.prisma.anchoringIntent.create({
        data: {
          proofId: "proof_that_does_not_exist",
          operation: AnchoringOperation.REVOKE,
          status: AnchoringStatus.PENDING,
        },
      }),
    ]);

    const error = await failing.catch((thrown: unknown) => thrown);
    expect(isForeignKeyViolation(error)).toBe(true);

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.status).toBe(ProofStatus.ACTIVE);
    expect(await db.prisma.anchoringIntent.count()).toBe(0);
  });

  it("leaves the database clean after a rolled-back transaction", async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            walletAddress: "GSYNTHETICROLLBACK".padEnd(56, "X"),
            walletHash: "sha256:synthetic-rollback",
          },
        });
        throw new DeliberateFailure();
      }),
    ).rejects.toBeInstanceOf(DeliberateFailure);

    expect(await nonEmptyTables(db.prisma)).toEqual([]);
  });
});

describe("constraint violations", () => {
  it("reports a duplicate wallet address as a unique violation", async () => {
    const user = await seedUser(db.prisma, "constraint-wallet");

    const duplicate = db.prisma.user.create({
      data: {
        walletAddress: user.walletAddress,
        walletHash: "sha256:synthetic-different-hash",
      },
    });

    await expect(duplicate).rejects.toMatchObject({ code: "P2002" });
  });

  it("reports a duplicate wallet hash separately from the address", async () => {
    // Both columns are independently unique. A single composite index would
    // let two rows share a hash as long as the addresses differed, which would
    // break the hash-based lookups the verification path uses.
    const user = await seedUser(db.prisma, "constraint-hash");

    const duplicate = db.prisma.user.create({
      data: {
        walletAddress: "GSYNTHETICDIFFERENT".padEnd(56, "X"),
        walletHash: user.walletHash,
      },
    });

    await expect(duplicate).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows one anchoring intent per proof and operation", async () => {
    const user = await seedUser(db.prisma, "constraint-anchor");
    const proof = await seedProof(db.prisma, "constraint-anchor-proof", user.id);

    await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      },
    });

    // A second REGISTER would let the worker submit the same proof twice.
    const duplicate = db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      },
    });
    await expect(duplicate).rejects.toMatchObject({ code: "P2002" });

    // A REVOKE for the same proof is a different operation and must be allowed.
    await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REVOKE,
        status: AnchoringStatus.PENDING,
      },
    });

    expect(await db.prisma.anchoringIntent.count()).toBe(2);
  });

  it("rejects a value outside an enum", async () => {
    // Enums are enforced by PostgreSQL, not by Prisma's types, so a raw write
    // from a migration or a script cannot smuggle an unknown status in.
    const user = await seedUser(db.prisma, "constraint-enum");

    const invalid = db.prisma.$executeRaw`
      INSERT INTO "Proof" (id, "userId", "proofType", "schemaVersion", status,
                           network, "assetCode", "expiresAt", "credentialHash", "updatedAt")
      VALUES ('synthetic_proof_bad_enum', ${user.id}, 'MINIMUM_INCOME', '1',
              'NOT_A_STATUS', 'testnet', 'USDC', now(), 'sha256:synthetic-bad-enum', now())
    `;

    await expect(invalid).rejects.toThrow();
    expect(await db.prisma.proof.count()).toBe(0);
  });

  it("enforces the declared column width", async () => {
    const user = await seedUser(db.prisma, "constraint-width");
    const organization = await db.prisma.organization.create({
      data: {
        name: "Synthetic Org",
        slug: "synthetic-org-width",
        createdById: user.id,
      },
    });

    // `ApiKey.prefix` is VarChar(8): the prefix is shown in the UI so an
    // operator can identify a key without revealing it, and a longer value
    // would silently change what "prefix" means.
    const tooLong = db.prisma.apiKey.create({
      data: {
        organizationId: organization.id,
        createdById: user.id,
        name: "Synthetic Key",
        prefix: "0123456789",
        keyHash: "sha256:synthetic-width",
      },
    });

    await expect(tooLong).rejects.toThrow();
    expect(await db.prisma.apiKey.count()).toBe(0);
  });
});

describe("isolation between concurrent transactions", () => {
  it("hides uncommitted work from another transaction", async () => {
    const user = await seedUser(db.prisma, "tx-isolation");

    let observedDuringWrite = -1;

    await db.prisma.$transaction(async (tx) => {
      await tx.proof.create({
        data: {
          userId: user.id,
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          network: "testnet",
          assetCode: "USDC",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          credentialHash: "sha256:synthetic-tx-isolation",
        },
      });

      // Read from outside the transaction, on a different connection.
      observedDuringWrite = await db.prisma.proof.count();
    });

    expect(observedDuringWrite).toBe(0);
    expect(await db.prisma.proof.count()).toBe(1);
  });
});
