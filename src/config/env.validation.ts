import { z } from "zod";

const optionalString = (schema: z.ZodString) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const encryptionKey = z.string().refine((value) => {
  const key = /^[a-fA-F0-9]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  return key.length === 32;
}, "PAYMENT_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex");

/** Optional bounded integer with a default, for operational limits. */
const positiveInt = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).optional().default(fallback);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  STELLAR_NETWORK: z.literal("testnet").default("testnet"),
  STELLAR_HORIZON_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  SESSION_SECRET: z.string().min(8),
  CREDENTIAL_SIGNING_SECRET: z.string().min(8),
  PAYMENT_ENCRYPTION_KEY: encryptionKey,
  CONTRACT_ANCHORING_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  CONTRACT_ANCHORING_REQUIRED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  STELLAR_CLI_PATH: optionalString(z.string().min(1)),
  STELLAR_CLI_SOURCE: optionalString(z.string().min(1)),
  PROOF_REGISTRY_CONTRACT_ID: optionalString(
    z.string().regex(/^C[A-Z2-7]{55}$/),
  ),
  ISSUER_REGISTRY_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  ISSUER_REGISTRY_CONTRACT_ID: optionalString(
    z.string().regex(/^C[A-Z2-7]{55}$/),
  ),
  EARNPROOF_ISSUER_ADDRESS: optionalString(z.string().regex(/^G[A-Z2-7]{55}$/)),
  EARNPROOF_SCHEMA_VERSION: z.coerce.number().int().positive().optional(),
  VERIFICATION_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(90),
  WEBHOOK_MAX_DELIVERY_ATTEMPTS: positiveInt(1, 20, 5),
  WEBHOOK_REDRIVE_MAX_BATCH: positiveInt(1, 100, 25),
  PROOF_SHARE_TOKEN_MAX_TTL_MINUTES: positiveInt(5, 525_600, 10_080),
  PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES: positiveInt(5, 525_600, 1_440),
  QUOTA_MAX_ACTIVE_API_KEYS: positiveInt(1, 10_000, 25),
  QUOTA_MAX_WEBHOOKS: positiveInt(1, 1_000, 10),
  QUOTA_PROOF_REQUESTS_PER_DAY: positiveInt(1, 10_000_000, 1_000),
  QUOTA_SYNCS_PER_HOUR: positiveInt(1, 3_600, 12),
  VERIFICATION_HASH_SALT_VERSION: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0),
});

export function validateEnv(config: Record<string, unknown>) {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }

  if (
    parsed.data.PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES >
    parsed.data.PROOF_SHARE_TOKEN_MAX_TTL_MINUTES
  ) {
    throw new Error(
      "Invalid environment: PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES must not exceed PROOF_SHARE_TOKEN_MAX_TTL_MINUTES",
    );
  }

  return parsed.data;
}
