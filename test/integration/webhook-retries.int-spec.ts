import { Prisma, WebhookDeliveryStatus } from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import {
  isUniqueViolation,
  race,
  seedDelivery,
  seedOrganization,
  seedUser,
  seedWebhook,
  violatedTarget,
} from "./harness/fixtures";

/**
 * Webhook retry persistence.
 *
 * `WebhookDeliveryService` records each attempt as its own row rather than
 * mutating a counter, so the delivery history survives a crash and every
 * attempt stays individually queryable. That design only works if the database
 * holds up its side: the retry chain has to be reconstructible from
 * `(eventId, attempt)`, the persisted `payload` has to round-trip through JSONB
 * byte-for-byte — a retry re-signs the stored body, so a payload PostgreSQL
 * reordered would produce a signature the integrator rejects — and `replayKey`
 * has to be unique or a double-clicked replay sends the event twice.
 *
 * These are properties of the schema, not of the service, and a mocked Prisma
 * client asserts none of them.
 *
 * Delivery itself is not exercised here. The fixture URLs resolve nowhere by
 * construction (RFC 2606 `.example.invalid`) and the SSRF guard refuses private
 * addresses, so there is no destination a test could legitimately deliver to;
 * the outbound path is covered by the unit suite with `fetch` stubbed.
 */

const db = integrationDatabase();

async function organizationWithWebhook(seed: string) {
  const user = await seedUser(db.prisma, seed);
  const organization = await seedOrganization(db.prisma, seed, user.id);
  const webhook = await seedWebhook(db.prisma, seed, organization.id);
  return { user, organization, webhook };
}

/** The envelope shape the service persists and re-signs on every attempt. */
function envelope(eventId: string) {
  return {
    specVersion: "1",
    id: eventId,
    event: "proof.created",
    createdAt: "2025-01-01T00:00:00.000Z",
    data: { proofId: "synthetic_proof_1", status: "ACTIVE" },
  };
}

describe("retry chains", () => {
  it("records every attempt as its own row under one event id", async () => {
    const { webhook } = await organizationWithWebhook("retry-chain");
    const eventId = "synthetic_event_retry_chain";

    // Attempt 1 fails and schedules attempt 2, which fails and schedules
    // attempt 3 — the sequence `runDelivery` writes.
    let previousId: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const row = await db.prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          eventType: "proof.created",
          eventId,
          payload: envelope(eventId) as unknown as Prisma.InputJsonValue,
          attempt,
          status: WebhookDeliveryStatus.PENDING,
          nextRetryAt: new Date(Date.parse("2025-01-01T00:00:00.000Z") + attempt * 1000),
        },
      });

      if (previousId) {
        await db.prisma.webhookDelivery.update({
          where: { id: previousId },
          data: {
            status: WebhookDeliveryStatus.FAILED,
            statusCode: 500,
            failureReason: "HTTP 500",
            deliveredAt: new Date(),
          },
        });
      }
      previousId = row.id;
    }

    const chain = await db.prisma.webhookDelivery.findMany({
      where: { eventId },
      orderBy: { attempt: "asc" },
    });

    expect(chain).toHaveLength(3);
    expect(chain.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(chain.slice(0, 2).map((row) => row.status)).toEqual([
      WebhookDeliveryStatus.FAILED,
      WebhookDeliveryStatus.FAILED,
    ]);
    expect(chain[2].status).toBe(WebhookDeliveryStatus.PENDING);

    // Every attempt carries the same event id, which is what lets an
    // integrator deduplicate on `X-EarnProof-Delivery`.
    expect(new Set(chain.map((row) => row.eventId)).size).toBe(1);
  });

  it("round-trips the signed payload through JSONB unchanged", async () => {
    const { webhook } = await organizationWithWebhook("retry-payload");
    const eventId = "synthetic_event_payload";
    const body = envelope(eventId);

    const row = await db.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: "proof.created",
        eventId,
        payload: body as unknown as Prisma.InputJsonValue,
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
      },
    });

    const stored = await db.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(stored.payload).toEqual(body);
  });

  it("finds the deliveries a restart must re-enqueue", async () => {
    const { webhook } = await organizationWithWebhook("retry-recovery");

    await seedDelivery(db.prisma, "recovery-done", webhook.id, {
      status: "SUCCESS",
    });
    await seedDelivery(db.prisma, "recovery-dead", webhook.id, {
      status: "FAILED",
      deliveredAt: null,
    });
    const pending = await seedDelivery(db.prisma, "recovery-live", webhook.id, {
      status: "PENDING",
      statusCode: null,
      deliveredAt: null,
    });

    // The query `WebhookDeliveryService.onModuleInit` issues on startup.
    const recovered = await db.prisma.webhookDelivery.findMany({
      where: { status: WebhookDeliveryStatus.PENDING },
      orderBy: { createdAt: "asc" },
      select: { id: true, webhookId: true, attempt: true, nextRetryAt: true },
    });

    expect(recovered.map((row) => row.id)).toEqual([pending.id]);
  });

  it("keeps the retry schedule queryable by status and due time", async () => {
    const { webhook } = await organizationWithWebhook("retry-schedule");
    const now = new Date("2025-06-01T12:00:00.000Z");

    await db.prisma.webhookDelivery.createMany({
      data: [
        {
          webhookId: webhook.id,
          eventType: "proof.created",
          eventId: "synthetic_event_due",
          payload: envelope("synthetic_event_due") as unknown as Prisma.InputJsonValue,
          attempt: 2,
          status: WebhookDeliveryStatus.PENDING,
          nextRetryAt: new Date(now.getTime() - 1_000),
        },
        {
          webhookId: webhook.id,
          eventType: "proof.created",
          eventId: "synthetic_event_later",
          payload: envelope("synthetic_event_later") as unknown as Prisma.InputJsonValue,
          attempt: 2,
          status: WebhookDeliveryStatus.PENDING,
          nextRetryAt: new Date(now.getTime() + 60_000),
        },
      ],
    });

    const due = await db.prisma.webhookDelivery.findMany({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        nextRetryAt: { lte: now },
      },
    });

    expect(due.map((row) => row.eventId)).toEqual(["synthetic_event_due"]);
  });
});

describe("replay idempotency", () => {
  it("refuses a second replay of the same delivery by the same actor", async () => {
    const { webhook } = await organizationWithWebhook("replay-unique");
    const original = await seedDelivery(db.prisma, "replay-original", webhook.id, {
      status: "FAILED",
      deliveredAt: null,
    });

    const replayKey = `${original.id}:synthetic_user_operator`;

    await db.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: original.eventType,
        eventId: original.eventId,
        payload: original.payload as Prisma.InputJsonValue,
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: original.id,
        replayedBy: "synthetic_user_operator",
        replayKey,
      },
    });

    const second = db.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: original.eventType,
        eventId: original.eventId,
        payload: original.payload as Prisma.InputJsonValue,
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: original.id,
        replayedBy: "synthetic_user_operator",
        replayKey,
      },
    });

    const error = await second.catch((thrown: unknown) => thrown);
    expect(isUniqueViolation(error)).toBe(true);
    expect(violatedTarget(error)).toContain("replayKey");
  });

  it("lets exactly one of several simultaneous replays through", async () => {
    const { webhook } = await organizationWithWebhook("replay-race");
    const original = await seedDelivery(db.prisma, "replay-race-original", webhook.id, {
      status: "FAILED",
      deliveredAt: null,
    });

    const replayKey = `${original.id}:synthetic_user_operator`;

    const attempts = Array.from({ length: 5 }, () =>
      db.prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          eventType: original.eventType,
          eventId: original.eventId,
          payload: original.payload as Prisma.InputJsonValue,
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
          replayOf: original.id,
          replayedBy: "synthetic_user_operator",
          replayKey,
        },
      }),
    );

    const { fulfilled, rejected } = await race(attempts);

    expect(fulfilled).toHaveLength(1);
    expect(rejected.every(isUniqueViolation)).toBe(true);
    expect(
      await db.prisma.webhookDelivery.count({ where: { replayKey } }),
    ).toBe(1);
  });

  it("allows different operators to replay the same delivery", async () => {
    const { webhook } = await organizationWithWebhook("replay-actors");
    const original = await seedDelivery(db.prisma, "replay-actors-original", webhook.id);

    for (const operator of ["operator_a", "operator_b"]) {
      await db.prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          eventType: original.eventType,
          eventId: original.eventId,
          payload: original.payload as Prisma.InputJsonValue,
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
          replayOf: original.id,
          replayedBy: operator,
          replayKey: `${original.id}:${operator}`,
        },
      });
    }

    expect(
      await db.prisma.webhookDelivery.count({ where: { replayOf: original.id } }),
    ).toBe(2);
  });
});

describe("delivery integrity", () => {
  it("refuses a delivery for a webhook that does not exist", async () => {
    const orphan = db.prisma.webhookDelivery.create({
      data: {
        webhookId: "webhook_that_does_not_exist",
        eventType: "proof.created",
        eventId: "synthetic_event_orphan",
        payload: envelope("synthetic_event_orphan") as unknown as Prisma.InputJsonValue,
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
      },
    });

    await expect(orphan).rejects.toMatchObject({ code: "P2003" });
  });

  it("stores the signing secret encrypted", async () => {
    const { webhook } = await organizationWithWebhook("webhook-secret");

    const raw = await db.prisma.$queryRaw<Array<{ secretEncrypted: string }>>`
      SELECT "secretEncrypted" FROM "Webhook" WHERE id = ${webhook.id}
    `;

    expect(raw[0].secretEncrypted.startsWith("enc:v0:")).toBe(true);
    expect(raw[0].secretEncrypted).not.toContain("synthetic-not-a-real-secret");
  });
});
