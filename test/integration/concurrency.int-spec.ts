import { ProofStatus, WebhookDeliveryStatus } from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import {
  isUniqueViolation,
  race,
  seedDelivery,
  seedOrganization,
  seedProof,
  seedUser,
  seedWebhook,
} from "./harness/fixtures";

/**
 * Concurrent writes.
 *
 * The service runs as more than one replica, and several of its write paths can
 * be entered twice at the same moment: two tabs revoking a proof, a payment
 * sync racing a retry of itself, an operator double-clicking replay. Each of
 * those is guarded by something the database enforces — a unique index, a
 * conditional `UPDATE`, an atomic increment — and none of those guards can be
 * exercised against a mock, because a mock has no notion of two writers.
 *
 * Concurrency here means real overlap: the operations are started together and
 * awaited with `Promise.allSettled`, so the database resolves them, not the
 * test.
 */

const db = integrationDatabase();

/** Kept below the pinned pool size so the database, not the pool, is the bottleneck. */
const CONCURRENT_TRANSACTIONS = 6;

describe("concurrent inserts", () => {
  it("lets exactly one writer claim a unique wallet address", async () => {
    const walletAddress = "GSYNTHETICCONTESTEDWALLET".padEnd(56, "X");

    const writers = Array.from({ length: 8 }, (_unused, index) =>
      db.prisma.user.create({
        data: {
          walletAddress,
          walletHash: `sha256:synthetic-contested-${index}`,
        },
      }),
    );

    const { fulfilled, rejected } = await race(writers);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(rejected.every(isUniqueViolation)).toBe(true);
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("serialises concurrent inserts that do not collide", async () => {
    const users = Array.from({ length: 12 }, (_unused, index) =>
      db.prisma.user.create({
        data: {
          walletAddress: `GSYNTHETICPARALLEL${index}`.padEnd(56, "X"),
          walletHash: `sha256:synthetic-parallel-${index}`,
        },
      }),
    );

    const { fulfilled, rejected } = await race(users);

    expect(rejected).toEqual([]);
    expect(fulfilled).toHaveLength(12);
    expect(await db.prisma.user.count()).toBe(12);
  });
});

describe("concurrent updates", () => {
  it("does not lose an increment under contention", async () => {
    const user = await seedUser(db.prisma, "concurrent-increment");
    const organization = await seedOrganization(db.prisma, "concurrent-increment", user.id);
    const webhook = await seedWebhook(db.prisma, "concurrent-increment", organization.id);
    const delivery = await seedDelivery(db.prisma, "concurrent-increment", webhook.id, {
      attempt: 0,
      status: "PENDING",
      statusCode: null,
      deliveredAt: null,
    });

    // `{ increment: 1 }` becomes `SET attempt = attempt + 1`, which PostgreSQL
    // evaluates under a row lock. Read-modify-write in application code would
    // lose updates here, and the symptom would be a delivery that retries
    // forever because its attempt counter never reaches the cap.
    const increments = Array.from({ length: 10 }, () =>
      db.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { attempt: { increment: 1 } },
      }),
    );

    const { rejected } = await race(increments);
    expect(rejected).toEqual([]);

    const stored = await db.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(stored.attempt).toBe(10);
  });

  it("lets exactly one concurrent revocation take effect", async () => {
    const user = await seedUser(db.prisma, "concurrent-revoke");
    const proof = await seedProof(db.prisma, "concurrent-revoke-proof", user.id);

    // The conditional-update guard the service uses: only rows still unrevoked
    // are touched, so the second writer reports zero rows rather than
    // overwriting the first writer's timestamp.
    const revocations = Array.from({ length: CONCURRENT_TRANSACTIONS }, () =>
      db.prisma.proof.updateMany({
        where: { id: proof.id, revokedAt: null },
        data: { status: ProofStatus.REVOKED, revokedAt: new Date() },
      }),
    );

    const { fulfilled, rejected } = await race(revocations);
    expect(rejected).toEqual([]);

    const applied = fulfilled.filter((result) => result.count === 1);
    expect(applied).toHaveLength(1);

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.status).toBe(ProofStatus.REVOKED);
  });

  it("keeps a claim-one-row queue from handing the same row to two workers", async () => {
    const user = await seedUser(db.prisma, "concurrent-claim");
    const organization = await seedOrganization(db.prisma, "concurrent-claim", user.id);
    const webhook = await seedWebhook(db.prisma, "concurrent-claim", organization.id);

    for (let index = 0; index < 4; index += 1) {
      await seedDelivery(db.prisma, `concurrent-claim-${index}`, webhook.id, {
        status: "PENDING",
        statusCode: null,
        deliveredAt: null,
      });
    }

    // `FOR UPDATE SKIP LOCKED` is the standard way to hand each queued row to
    // exactly one worker. Without SKIP LOCKED the workers would queue behind
    // one another and then all claim the same row.
    const claim = () =>
      db.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "WebhookDelivery"
           WHERE status = 'PENDING'::"WebhookDeliveryStatus"
           ORDER BY "createdAt"
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        `;

        if (rows.length === 0) return null;

        await tx.webhookDelivery.update({
          where: { id: rows[0].id },
          data: { status: WebhookDeliveryStatus.SUCCESS, deliveredAt: new Date() },
        });

        return rows[0].id;
      });

    const { fulfilled, rejected } = await race(
      Array.from({ length: 4 }, () => claim()),
    );

    expect(rejected).toEqual([]);

    const claimed = fulfilled.filter((id): id is string => id !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(
      await db.prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.PENDING },
      }),
    ).toBe(4 - claimed.length);
  });
});

describe("concurrent transactions", () => {
  it("commits overlapping transactions that touch different rows", async () => {
    const users = await Promise.all(
      Array.from({ length: CONCURRENT_TRANSACTIONS }, (_unused, index) =>
        seedUser(db.prisma, `concurrent-tx-${index}`),
      ),
    );

    const transactions = users.map((user, index) =>
      db.prisma.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: user.id,
            action: "concurrent.probe",
            resourceType: "user",
            resourceId: user.id,
          },
        });
        await tx.trustedSource.create({
          data: {
            userId: user.id,
            sourceAddress: `GSYNTHETICCONCURRENT${index}`.padEnd(56, "X"),
            sourceType: "employer",
          },
        });
      }),
    );

    const { rejected } = await race(transactions);

    expect(rejected).toEqual([]);
    expect(await db.prisma.auditLog.count()).toBe(CONCURRENT_TRANSACTIONS);
    expect(await db.prisma.trustedSource.count()).toBe(CONCURRENT_TRANSACTIONS);
  });

  it("does not deadlock when transactions lock rows in a consistent order", async () => {
    const first = await seedUser(db.prisma, "deadlock-first");
    const second = await seedUser(db.prisma, "deadlock-second");

    // Both transactions update the same two rows in the same order. Reversing
    // the order in one of them is the classic deadlock, and this asserts the
    // ordering discipline actually avoids it.
    const ordered = [first.id, second.id];

    const transactions = Array.from({ length: CONCURRENT_TRANSACTIONS }, () =>
      db.prisma.$transaction(async (tx) => {
        for (const id of ordered) {
          await tx.user.update({
            where: { id },
            data: { lastLoginAt: new Date() },
          });
        }
      }),
    );

    const { rejected } = await race(transactions);
    expect(rejected).toEqual([]);

    const rows = await db.prisma.user.findMany({ where: { id: { in: ordered } } });
    expect(rows.every((row) => row.lastLoginAt !== null)).toBe(true);
  });

  it("rolls back only the transaction that failed", async () => {
    const survivor = await seedUser(db.prisma, "partial-survivor");
    const casualty = await seedUser(db.prisma, "partial-casualty");

    const failing = db.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: casualty.id,
          action: "will.roll.back",
          resourceType: "user",
        },
      });
      throw new Error("deliberate failure");
    });

    const succeeding = db.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: survivor.id,
          action: "will.commit",
          resourceType: "user",
        },
      });
    });

    const { rejected } = await race([failing, succeeding]);
    expect(rejected).toHaveLength(1);

    const logs = await db.prisma.auditLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(survivor.id);
  });
});
