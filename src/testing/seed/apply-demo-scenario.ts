import { PrismaClient } from "@prisma/client";
import { DemoScenario } from "../factories/scenario";

/**
 * Writes a demo scenario to a database.
 *
 * Extracted from `prisma/seed-demo.ts` so the seed can be exercised by tests
 * against a disposable PostgreSQL database rather than only by running the
 * script and reading its output. The script keeps the guard and the reporting;
 * this holds the writes.
 *
 * Two properties are load-bearing and are asserted in
 * `test/integration/seed-reset.int-spec.ts`:
 *
 * - **Idempotent.** Every write is an upsert keyed on a deterministic synthetic
 *   id, so seeding twice converges rather than accumulating duplicates, and a
 *   seed interrupted halfway is repaired by running it again.
 * - **Ordered by the foreign-key graph.** Users, then the organizations they
 *   create, then everything hanging off those. A partial failure therefore
 *   leaves a prefix of the graph, which is a consistent state that the next run
 *   completes — not a set of dangling references.
 */

/** How many rows of each kind the scenario writes. */
export interface SeedCounts {
  users: number;
  organizations: number;
  issuers: number;
  payments: number;
  proofs: number;
  apiKeys: number;
  webhooks: number;
  deliveries: number;
  anchoringIntents: number;
}

export async function applyDemoScenario(
  prisma: PrismaClient,
  scenario: DemoScenario,
): Promise<SeedCounts> {
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
        // The plaintext `amount` from the factory is intentionally NOT written:
        // the schema stores amountEncrypted, and seeding around that would
        // model a privacy boundary the application does not have.
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

  for (const apiKey of scenario.apiKeys) {
    await prisma.apiKey.upsert({
      where: { id: apiKey.id },
      update: { status: apiKey.status },
      create: {
        id: apiKey.id,
        organizationId: apiKey.organizationId,
        createdById: apiKey.createdById,
        name: apiKey.name,
        prefix: apiKey.prefix,
        // A synthetic marker, not a hash of anything usable: the factory's
        // "secret" is a placeholder string and no code path accepts it.
        keyHash: apiKey.keyHash,
        status: apiKey.status,
        expiresAt: apiKey.expiresAt,
        revokedAt: apiKey.revokedAt,
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
        // The schema stores the secret encrypted. The factory's value is a
        // synthetic placeholder, not a real credential, and is written here
        // only so the column is populated for local use.
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
        attempt: delivery.attempt,
        status: delivery.status,
        statusCode: delivery.statusCode,
        failureReason: delivery.failureReason,
        deliveredAt: delivery.deliveredAt,
      },
    });
  }

  for (const intent of scenario.anchoringIntents) {
    await prisma.anchoringIntent.upsert({
      where: { id: intent.id },
      update: { status: intent.status },
      create: {
        id: intent.id,
        proofId: intent.proofId,
        operation: intent.operation,
        status: intent.status,
        attemptCount: intent.attempts,
        transactionHash: intent.transactionHash,
      },
    });
  }

  return {
    users: scenario.users.length,
    organizations: scenario.organizations.length,
    issuers: scenario.issuers.length,
    payments: scenario.payments.length,
    proofs: scenario.proofs.length,
    apiKeys: scenario.apiKeys.length,
    webhooks: scenario.webhooks.length,
    deliveries: scenario.deliveries.length,
    anchoringIntents: scenario.anchoringIntents.length,
  };
}

/**
 * Reads how much of a scenario is actually present.
 *
 * Counted by identifier, not by table total, so a database that also holds
 * other records still gives a meaningful answer.
 */
export async function readScenarioCounts(
  prisma: PrismaClient,
  scenario: DemoScenario,
): Promise<SeedCounts> {
  const ids = <T extends { id: string }>(records: T[]) =>
    records.map((record) => record.id);

  const [
    users,
    organizations,
    issuers,
    payments,
    proofs,
    apiKeys,
    webhooks,
    deliveries,
    anchoringIntents,
  ] = await Promise.all([
    prisma.user.count({ where: { id: { in: ids(scenario.users) } } }),
    prisma.organization.count({
      where: { id: { in: ids(scenario.organizations) } },
    }),
    prisma.issuer.count({ where: { id: { in: ids(scenario.issuers) } } }),
    prisma.payment.count({ where: { id: { in: ids(scenario.payments) } } }),
    prisma.proof.count({ where: { id: { in: ids(scenario.proofs) } } }),
    prisma.apiKey.count({ where: { id: { in: ids(scenario.apiKeys) } } }),
    prisma.webhook.count({ where: { id: { in: ids(scenario.webhooks) } } }),
    prisma.webhookDelivery.count({
      where: { id: { in: ids(scenario.deliveries) } },
    }),
    prisma.anchoringIntent.count({
      where: { id: { in: ids(scenario.anchoringIntents) } },
    }),
  ]);

  return {
    users,
    organizations,
    issuers,
    payments,
    proofs,
    apiKeys,
    webhooks,
    deliveries,
    anchoringIntents,
  };
}

/** What the scenario should produce, for comparison against the above. */
export function expectedScenarioCounts(scenario: DemoScenario): SeedCounts {
  return {
    users: scenario.users.length,
    organizations: scenario.organizations.length,
    issuers: scenario.issuers.length,
    payments: scenario.payments.length,
    proofs: scenario.proofs.length,
    apiKeys: scenario.apiKeys.length,
    webhooks: scenario.webhooks.length,
    deliveries: scenario.deliveries.length,
    anchoringIntents: scenario.anchoringIntents.length,
  };
}

/**
 * Names every record class whose count differs from the scenario.
 *
 * This is what makes a partially applied seed *detectable*: an interrupted run
 * leaves fewer rows than the scenario declares, and the difference is reported
 * per class rather than as a single "something is wrong". An empty array means
 * the database holds the whole scenario.
 */
export function describeSeedDrift(
  expected: SeedCounts,
  actual: SeedCounts,
): string[] {
  return (Object.keys(expected) as Array<keyof SeedCounts>)
    .filter((key) => expected[key] !== actual[key])
    .map((key) => `${key}: expected ${expected[key]}, found ${actual[key]}`);
}
