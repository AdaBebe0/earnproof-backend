import { PaymentClassification } from "@prisma/client";
import { decryptProtectedAmount } from "../../src/common/crypto/protected-amount";
import { integrationDatabase } from "./harness/database";
import {
  isUniqueViolation,
  race,
  seedPayment,
  seedUser,
  violatedTarget,
} from "./harness/fixtures";

/**
 * Payment uniqueness and the encrypted-amount boundary.
 *
 * `operationId` is unique because a Stellar operation is indexed exactly once:
 * payment synchronisation is re-run on every login and after every Horizon
 * gap, and the upsert it performs is only idempotent because the database
 * refuses the second insert. If that index were ever dropped, `syncPayments`
 * would silently duplicate income — and every proof built on that income would
 * overstate it. Nothing in the unit suite would notice.
 */

const db = integrationDatabase();

describe("payment uniqueness", () => {
  it("refuses a second payment for the same Stellar operation", async () => {
    const user = await seedUser(db.prisma, "payment-unique");
    const first = await seedPayment(db.prisma, "payment-unique-1", user.id);

    const duplicate = seedPayment(db.prisma, "payment-unique-2", user.id, {
      operationId: first.row.operationId,
    });

    const error = await duplicate.catch((thrown: unknown) => thrown);

    expect(isUniqueViolation(error)).toBe(true);
    expect(violatedTarget(error)).toContain("operationId");
    expect(await db.prisma.payment.count()).toBe(1);
  });

  it("is unique across users, not per user", async () => {
    // Two users cannot both claim the same Stellar operation. Scoping the index
    // per user would let a second account index someone else's income.
    const alice = await seedUser(db.prisma, "payment-alice");
    const bob = await seedUser(db.prisma, "payment-bob");

    const first = await seedPayment(db.prisma, "payment-shared-op", alice.id);

    const stolen = seedPayment(db.prisma, "payment-stolen-op", bob.id, {
      operationId: first.row.operationId,
    });

    await expect(stolen).rejects.toMatchObject({ code: "P2002" });
  });

  it("makes an upsert on operationId idempotent", async () => {
    const user = await seedUser(db.prisma, "payment-upsert");
    const seeded = await seedPayment(db.prisma, "payment-upsert-1", user.id);

    const update = {
      isEligible: false,
      occurredAt: new Date("2025-02-01T00:00:00.000Z"),
    };

    const create = {
      userId: user.id,
      operationId: seeded.row.operationId,
      stellarTransactionHash: seeded.row.stellarTransactionHash,
      sourceAddress: seeded.row.sourceAddress,
      destinationAddress: seeded.row.destinationAddress,
      assetCode: seeded.row.assetCode,
      assetIssuer: seeded.row.assetIssuer,
      amountEncrypted: seeded.row.amountEncrypted,
      occurredAt: update.occurredAt,
      classification: PaymentClassification.UNKNOWN,
      isEligible: false,
    };

    // This is the shape `PaymentsService.syncPayments` issues per operation.
    for (let run = 0; run < 3; run += 1) {
      await db.prisma.payment.upsert({
        where: { operationId: seeded.row.operationId },
        update,
        create,
      });
    }

    expect(await db.prisma.payment.count()).toBe(1);

    const stored = await db.prisma.payment.findUniqueOrThrow({
      where: { operationId: seeded.row.operationId },
    });
    expect(stored.id).toBe(seeded.row.id);
    expect(stored.isEligible).toBe(false);
    expect(stored.occurredAt).toEqual(update.occurredAt);
  });

  it("lets exactly one of many concurrent syncs insert an operation", async () => {
    const user = await seedUser(db.prisma, "payment-concurrent");
    const operationId = "synthetic-op-concurrent";

    const writers = Array.from({ length: 8 }, (_unused, index) =>
      seedPayment(db.prisma, `payment-concurrent-${index}`, user.id, {
        operationId,
      }),
    );

    const { fulfilled, rejected } = await race(writers);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(rejected.every(isUniqueViolation)).toBe(true);
    expect(await db.prisma.payment.count()).toBe(1);
  });
});

describe("trusted source uniqueness", () => {
  it("refuses the same source address twice for one user", async () => {
    const user = await seedUser(db.prisma, "trusted-unique");
    const sourceAddress = "GSYNTHETICTRUSTEDSOURCE".padEnd(56, "X");

    await db.prisma.trustedSource.create({
      data: { userId: user.id, sourceAddress, sourceType: "employer" },
    });

    const duplicate = db.prisma.trustedSource.create({
      data: { userId: user.id, sourceAddress, sourceType: "employer" },
    });

    const error = await duplicate.catch((thrown: unknown) => thrown);
    expect(isUniqueViolation(error)).toBe(true);
    expect(violatedTarget(error)).toEqual(
      expect.arrayContaining(["userId", "sourceAddress"]),
    );
  });

  it("allows two users to trust the same source", async () => {
    const alice = await seedUser(db.prisma, "trusted-alice");
    const bob = await seedUser(db.prisma, "trusted-bob");
    const sourceAddress = "GSYNTHETICSHAREDEMPLOYER".padEnd(56, "X");

    await db.prisma.trustedSource.create({
      data: { userId: alice.id, sourceAddress, sourceType: "employer" },
    });
    await db.prisma.trustedSource.create({
      data: { userId: bob.id, sourceAddress, sourceType: "employer" },
    });

    expect(await db.prisma.trustedSource.count()).toBe(2);
  });
});

describe("protected amounts", () => {
  it("never stores a plaintext amount", async () => {
    const user = await seedUser(db.prisma, "payment-amount");
    const { row, amount } = await seedPayment(db.prisma, "payment-amount-1", user.id, {
      amount: "1234.5670000",
    });

    // Read the column as raw text, so this asserts on what PostgreSQL holds
    // rather than on what Prisma chose to return.
    const raw = await db.prisma.$queryRaw<Array<{ amountEncrypted: string | null }>>`
      SELECT "amountEncrypted" FROM "Payment" WHERE id = ${row.id}
    `;

    const stored = raw[0].amountEncrypted ?? "";
    expect(stored).not.toContain(amount);
    expect(stored.startsWith("enc:v0:")).toBe(true);
    expect(
      decryptProtectedAmount(
        stored,
        new Map([[0, process.env.PAYMENT_ENCRYPTION_KEY as string]]),
      ),
    ).toBe(amount);
  });

  it("produces a different ciphertext for the same amount each time", async () => {
    // A deterministic ciphertext would let anyone with read access to the table
    // group users by income without decrypting anything.
    const user = await seedUser(db.prisma, "payment-iv");

    const first = await seedPayment(db.prisma, "payment-iv-1", user.id, {
      amount: "500.0000000",
    });
    const second = await seedPayment(db.prisma, "payment-iv-2", user.id, {
      amount: "500.0000000",
    });

    expect(first.row.amountEncrypted).not.toBe(second.row.amountEncrypted);
  });
});

describe("payment classification audit", () => {
  it("records a classification change alongside the payment", async () => {
    const user = await seedUser(db.prisma, "payment-audit");
    const { row } = await seedPayment(db.prisma, "payment-audit-1", user.id, {
      classification: "UNKNOWN",
    });

    // The service writes the update and the audit entry as two statements. The
    // point of checking here is that the audit row's polymorphic actor columns
    // accept a user actor, which is what the `make_audit_actor_polymorphic`
    // migration changed.
    await db.prisma.payment.update({
      where: { id: row.id },
      data: { classification: PaymentClassification.INCOME },
    });
    await db.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "payment.classification.updated",
        resourceType: "payment",
        resourceId: row.id,
        metadata: {
          previousClassification: "UNKNOWN",
          nextClassification: "INCOME",
        },
      },
    });

    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: row.id },
    });

    expect(audit.actorType).toBe("user");
    expect(audit.actorId).toBe(user.id);
    // The audit metadata must describe the change without carrying the amount.
    expect(JSON.stringify(audit.metadata)).not.toContain("amount");
  });
});
