import { PrismaClient } from "@prisma/client";
import {
  assertSeedAllowed,
  buildDemoScenario,
} from "../src/testing/factories/scenario";

/**
 * Opt-in demo seed.
 *
 * Deliberately separate from `prisma/seed.ts`. That file seeds reference data
 * (supported assets) that every environment legitimately needs; this one writes
 * fabricated users, payments, and proofs, which only a local or disposable
 * environment should ever contain. Keeping them apart means no routine
 * `prisma db seed` can pull demo records in by accident.
 *
 * Run with:
 *   npx ts-node prisma/seed-demo.ts
 *
 * Every write is an upsert keyed on a deterministic synthetic id, so re-running
 * converges rather than accumulating duplicates.
 */
async function main(): Promise<void> {
  // Checked before a client is even constructed: refusing after opening a
  // connection to production would already be later than anyone wants.
  assertSeedAllowed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    allowOverride: process.env.ALLOW_SYNTHETIC_SEED,
  });

  const prisma = new PrismaClient();
  const scenario = buildDemoScenario("demo");

  try {
    // Insertion order follows the foreign-key graph: users, then the
    // organizations they create, then everything hanging off those.
    for (const user of scenario.users) {
      await prisma.user.upsert({
        where: { id: user.id },
        update: { role: user.role, status: user.status },
        create: {
          id: user.id,
          walletAddress: user.walletAddress,
          walletHash: user.walletHash,
          role: user.role,
          status: user.status,
        },
      });
    }

    for (const organization of scenario.organizations) {
      await prisma.organization.upsert({
        where: { id: organization.id },
        update: { name: organization.name, status: organization.status },
        create: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          website: organization.website,
          status: organization.status,
          createdById: organization.createdById,
        },
      });
    }

    for (const issuer of scenario.issuers) {
      await prisma.issuer.upsert({
        where: { id: issuer.id },
        update: { status: issuer.status },
        create: {
          id: issuer.id,
          organizationId: issuer.organizationId,
          stellarAddress: issuer.stellarAddress,
          status: issuer.status,
          verifiedAt: issuer.verifiedAt,
          suspendedAt: issuer.suspendedAt,
          revokedAt: issuer.revokedAt,
        },
      });
    }

    for (const payment of scenario.payments) {
      await prisma.payment.upsert({
        where: { id: payment.id },
        update: { classification: payment.classification },
        create: {
          id: payment.id,
          userId: payment.userId,
          stellarTransactionHash: payment.stellarTransactionHash,
          operationId: payment.operationId,
          sourceAddress: payment.sourceAddress,
          destinationAddress: payment.destinationAddress,
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          // The plaintext `amount` from the factory is intentionally NOT
          // written: the schema stores amountEncrypted, and seeding around that
          // would model a privacy boundary the application does not have.
          occurredAt: payment.occurredAt,
          classification: payment.classification,
          isEligible: payment.isEligible,
        },
      });
    }

    for (const proof of scenario.proofs) {
      await prisma.proof.upsert({
        where: { id: proof.id },
        update: { status: proof.status },
        create: {
          id: proof.id,
          userId: proof.userId,
          proofType: proof.proofType as never,
          schemaVersion: proof.schemaVersion,
          status: proof.status as never,
          network: proof.network,
          assetCode: proof.assetCode,
          expiresAt: proof.expiresAt,
          credentialHash: proof.credentialHash,
          contractTransactionHash: proof.contractTransactionHash,
          revokedAt: proof.revokedAt,
        },
      });
    }

    for (const webhook of scenario.webhooks) {
      await prisma.webhook.upsert({
        where: { id: webhook.id },
        update: { url: webhook.url },
        create: {
          id: webhook.id,
          organizationId: webhook.organizationId,
          url: webhook.url,
          // The schema stores the secret encrypted. The factory's plaintext
          // value is a synthetic placeholder, not a real credential, and is
          // written here only so the column is populated for local use.
          secretEncrypted: webhook.secret,
          events: ["proof.created"],
        },
      });
    }

    for (const delivery of scenario.deliveries) {
      await prisma.webhookDelivery.upsert({
        where: { id: delivery.id },
        update: { status: delivery.status },
        create: {
          id: delivery.id,
          webhookId: delivery.webhookId,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          payload: delivery.payload as object,
          // Synthetic demo rows: the stored body is what a retry would send.
          schemaVersion: "1",
          payloadBody: JSON.stringify(delivery.payload),
          attempt: delivery.attempt,
          status: delivery.status,
          statusCode: delivery.statusCode,
          failureReason: delivery.failureReason,
          deliveredAt: delivery.deliveredAt,
        },
      });
    }

    const counts = {
      users: scenario.users.length,
      organizations: scenario.organizations.length,
      issuers: scenario.issuers.length,
      payments: scenario.payments.length,
      proofs: scenario.proofs.length,
      webhooks: scenario.webhooks.length,
      deliveries: scenario.deliveries.length,
    };

    console.log("Synthetic demo scenario seeded:", counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
