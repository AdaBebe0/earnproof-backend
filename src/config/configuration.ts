export const configuration = () => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  stellar: {
    network: process.env.STELLAR_NETWORK ?? "testnet",
    horizonUrl:
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ??
      "Test SDF Network ; September 2015",
  },
  sessionSecret: process.env.SESSION_SECRET,
  credentialSigningSecret: process.env.CREDENTIAL_SIGNING_SECRET,
  paymentEncryptionKey: process.env.PAYMENT_ENCRYPTION_KEY,
  verificationEventRetentionDays: Number(
    process.env.VERIFICATION_EVENT_RETENTION_DAYS ?? 90,
  ),
  verificationHashSaltVersion: Number(
    process.env.VERIFICATION_HASH_SALT_VERSION ?? 0,
  ),
  contractAnchoring: {
    enabled: process.env.CONTRACT_ANCHORING_ENABLED === "true",
    required: process.env.CONTRACT_ANCHORING_REQUIRED === "true",
    stellarCliPath: process.env.STELLAR_CLI_PATH ?? "stellar",
    source: process.env.STELLAR_CLI_SOURCE,
    proofRegistryContractId: process.env.PROOF_REGISTRY_CONTRACT_ID,
    issuerAddress: process.env.EARNPROOF_ISSUER_ADDRESS,
    schemaVersion: Number(process.env.EARNPROOF_SCHEMA_VERSION ?? 1),
  },
  health: {
    // Probe timeout. Must stay below the orchestrator's own probe timeout, or a
    // slow dependency produces overlapping in-flight probes against a system
    // that is already struggling.
    probeTimeoutMs: Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 2000),
    // How long a probe result is reused. Readiness is polled continuously by
    // every replica and load balancer, so without caching the probe load scales
    // with poll rate rather than with anything meaningful.
    cacheTtlMs: Number(process.env.HEALTH_CACHE_TTL_MS ?? 5000),
  },
  webhooks: {
    // Attempts per delivery chain before the terminal attempt is
    // dead-lettered. Automatic retries never exceed this.
    maxDeliveryAttempts: Number(process.env.WEBHOOK_MAX_DELIVERY_ATTEMPTS ?? 5),
    // Upper bound on one bounded-batch redrive request.
    maxRedriveBatchSize: Number(process.env.WEBHOOK_REDRIVE_MAX_BATCH ?? 25),
  },
  proofSharing: {
    // Longest lifetime a share token may be issued with. A token never
    // outlives the proof it shares either.
    maxTtlMinutes: Number(process.env.PROOF_SHARE_TOKEN_MAX_TTL_MINUTES ?? 10_080),
    defaultTtlMinutes: Number(
      process.env.PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES ?? 1_440,
    ),
  },
  // Per-organization operational quotas. Every organization is held to these
  // limits independently; see docs/quotas.md.
  quotas: {
    maxActiveApiKeys: Number(process.env.QUOTA_MAX_ACTIVE_API_KEYS ?? 25),
    maxWebhooks: Number(process.env.QUOTA_MAX_WEBHOOKS ?? 10),
    proofRequestsPerDay: Number(process.env.QUOTA_PROOF_REQUESTS_PER_DAY ?? 1_000),
    syncsPerHour: Number(process.env.QUOTA_SYNCS_PER_HOUR ?? 12),
  },
  issuerRegistry: {
    enabled: process.env.ISSUER_REGISTRY_ENABLED === "true",
    stellarCliPath: process.env.STELLAR_CLI_PATH ?? "stellar",
    source: process.env.STELLAR_CLI_SOURCE,
    contractId: process.env.ISSUER_REGISTRY_CONTRACT_ID,
  },
});
