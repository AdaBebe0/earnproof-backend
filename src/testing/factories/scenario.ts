import {
  ApiKeyInput,
  AnchoringIntentInput,
  IssuerInput,
  OrganizationInput,
  PaymentInput,
  ProofInput,
  UserInput,
  WebhookDeliveryInput,
  WebhookInput,
  buildAnchoringIntent,
  buildApiKey,
  buildDelivery,
  buildIssuer,
  buildOrganization,
  buildPayment,
  buildProof,
  buildUser,
  buildWebhook,
  excludedPayment,
  expiredApiKey,
  expiredProof,
  failedAnchoringIntent,
  failedDelivery,
  pendingDelivery,
  revokedApiKey,
  revokedIssuer,
  revokedProof,
  suspendedIssuer,
  suspendedUser,
  unanchoredProof,
} from "./index";

/**
 * A complete, relationally valid demo scenario.
 *
 * Assembled as one object rather than a pile of loose records so that every
 * foreign key is satisfied by construction. Hand-built fixtures usually get the
 * happy path right and the failure states wrong, which is exactly backwards:
 * the failure states are what the interesting tests exercise.
 */
export interface DemoScenario {
  users: UserInput[];
  organizations: OrganizationInput[];
  issuers: IssuerInput[];
  payments: PaymentInput[];
  proofs: ProofInput[];
  apiKeys: ApiKeyInput[];
  webhooks: WebhookInput[];
  deliveries: WebhookDeliveryInput[];
  anchoringIntents: AnchoringIntentInput[];
}

/**
 * Build the standard demo scenario.
 *
 * Pure and deterministic: the same seed always yields a byte-identical scenario,
 * which is what lets the seed script be safely idempotent and lets tests compare
 * whole snapshots.
 */
export function buildDemoScenario(seed = "demo"): DemoScenario {
  const worker = buildUser(`${seed}-worker`);
  const issuerUser = buildUser(`${seed}-issuer-user`, { role: "ISSUER" });
  const admin = buildUser(`${seed}-admin`, { role: "ADMIN" });
  const suspended = suspendedUser(`${seed}-suspended`);

  const organization = buildOrganization(`${seed}-org`, admin.id);
  const pendingOrganization = buildOrganization(
    `${seed}-org-pending`,
    admin.id,
    { status: "PENDING" },
  );

  const activeIssuer = buildIssuer(`${seed}-issuer`, organization.id);
  const suspendedIss = suspendedIssuer(
    `${seed}-issuer-suspended`,
    organization.id,
  );
  const revokedIss = revokedIssuer(`${seed}-issuer-revoked`, organization.id);

  const payments = [
    buildPayment(`${seed}-pay-1`, worker.id),
    buildPayment(`${seed}-pay-2`, worker.id),
    excludedPayment(`${seed}-pay-3`, worker.id),
    buildPayment(`${seed}-pay-4`, issuerUser.id),
  ];

  // Every proof lifecycle state the application distinguishes, so a contributor
  // never has to hand-construct the awkward ones.
  const activeProof = buildProof(`${seed}-proof-active`, worker.id);
  const expired = expiredProof(`${seed}-proof-expired`, worker.id);
  const revoked = revokedProof(`${seed}-proof-revoked`, worker.id);
  const unanchored = unanchoredProof(`${seed}-proof-unanchored`, worker.id);

  const apiKeys = [
    buildApiKey(`${seed}-key-active`, organization.id, admin.id),
    expiredApiKey(`${seed}-key-expired`, organization.id, admin.id),
    revokedApiKey(`${seed}-key-revoked`, organization.id, admin.id),
  ];

  const webhook = buildWebhook(`${seed}-webhook`, organization.id);

  const deliveries = [
    buildDelivery(`${seed}-delivery-ok`, webhook.id),
    failedDelivery(`${seed}-delivery-failed`, webhook.id),
    pendingDelivery(`${seed}-delivery-pending`, webhook.id),
  ];

  const anchoringIntents = [
    buildAnchoringIntent(`${seed}-anchor-ok`, activeProof.id),
    failedAnchoringIntent(`${seed}-anchor-failed`, unanchored.id),
  ];

  return {
    users: [worker, issuerUser, admin, suspended],
    organizations: [organization, pendingOrganization],
    issuers: [activeIssuer, suspendedIss, revokedIss],
    payments,
    proofs: [activeProof, expired, revoked, unanchored],
    apiKeys,
    webhooks: [webhook],
    deliveries,
    anchoringIntents,
  };
}

/** Raised when a destructive seed is attempted against a protected target. */
export class ProductionSeedRefusedError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to seed synthetic data: ${reason}. ` +
        "Seeding is only permitted against a local or test database.",
    );
    this.name = "ProductionSeedRefusedError";
  }
}

export interface SeedEnvironment {
  nodeEnv?: string;
  databaseUrl?: string;
  allowOverride?: string;
}

/**
 * Decide whether seeding synthetic data is permitted.
 *
 * Fails closed on every uncertain input. Seeding writes fabricated users,
 * payments, and proofs; doing that to a production database corrupts real
 * records, and no amount of care afterwards fully undoes it. An explicit refusal
 * that occasionally annoys a developer is enormously cheaper than one accident.
 *
 * The checks, in order:
 *
 * 1. `NODE_ENV=production` refuses outright, and cannot be overridden.
 * 2. A missing database URL refuses — an unknown target is not a safe target.
 * 3. A host that does not look local refuses unless explicitly overridden.
 *
 * The override exists for CI containers and disposable review environments,
 * whose hostnames are not localhost. It deliberately cannot bypass check 1.
 */
export function assertSeedAllowed(env: SeedEnvironment): void {
  const nodeEnv = (env.nodeEnv ?? "").trim().toLowerCase();

  if (nodeEnv === "production") {
    throw new ProductionSeedRefusedError("NODE_ENV is production");
  }

  const databaseUrl = (env.databaseUrl ?? "").trim();
  if (databaseUrl === "") {
    throw new ProductionSeedRefusedError("DATABASE_URL is not set");
  }

  if (env.allowOverride === "true") {
    return;
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    // An unparseable URL is an unknown target, and unknown targets fail closed.
    throw new ProductionSeedRefusedError("DATABASE_URL could not be parsed");
  }

  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "host.docker.internal",
    "postgres",
    "db",
  ]);

  if (!localHosts.has(host)) {
    throw new ProductionSeedRefusedError(
      `database host "${host}" is not recognised as local. ` +
        "Set ALLOW_SYNTHETIC_SEED=true to override for a disposable environment",
    );
  }
}
