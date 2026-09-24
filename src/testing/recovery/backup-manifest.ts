import { createHash } from "node:crypto";

/**
 * Synthetic backup manifest format.
 *
 * A backup is only worth having if a restore has actually been rehearsed. The
 * common failure is not that backups are missing — it is that nobody discovers
 * until an incident that the dump was truncated, that a migration never
 * replayed, or that the encryption key needed to read the restored rows was
 * itself only stored in the system that was lost.
 *
 * This module defines the manifest that accompanies a dump and the validation a
 * drill runs against it, so those failures surface during a rehearsal rather
 * than during an outage.
 */

/** Recovery objectives the drill validates against. */
export const RecoveryObjectives = {
  /** Maximum tolerable data loss. Bounded by backup frequency. */
  RPO_MINUTES: 60,
  /** Maximum tolerable time to restore service. */
  RTO_MINUTES: 240,
} as const;

/**
 * State domains a coherent restore must reproduce together.
 *
 * Listed explicitly because partial coherence is the dangerous outcome: proofs
 * restored without their revocations produces a system that will confidently
 * verify a credential its issuer already withdrew. That is worse than a failed
 * restore, because it looks like success.
 */
export const RequiredDomains = [
  "proof_lifecycle",
  "revocation",
  "anchoring_intent",
  "api_keys",
  "webhooks",
] as const;

export type RequiredDomain = (typeof RequiredDomains)[number];

export interface DomainSnapshot {
  domain: RequiredDomain;
  rowCount: number;
  /** Digest over the domain's restored content, for coherence comparison. */
  checksum: string;
}

export interface BackupManifest {
  /** Manifest format version, so a drill can reject a shape it cannot read. */
  formatVersion: "1";
  /** ISO-8601 timestamp at which the dump was taken. */
  takenAt: string;
  /**
   * The latest migration applied when the dump was taken.
   *
   * Restoring a dump into a schema at a different migration is a silent
   * corruption risk, so the drill compares this rather than assuming.
   */
  migrationVersion: string;
  /** Whether the dump body is encrypted at rest. */
  encrypted: boolean;
  /**
   * Identifier of the key needed to decrypt, NOT the key itself.
   *
   * The key material lives in the external key manager. A backup that carried
   * its own decryption key would reduce to an unencrypted backup the moment it
   * was copied anywhere.
   */
  encryptionKeyId: string | null;
  domains: DomainSnapshot[];
}

/** Result of validating a manifest. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Patterns that must never appear inside a backup manifest or drill output.
 *
 * Manifests get copied into runbooks, tickets, and CI logs. A manifest that
 * embedded a key or a connection string would spread that secret everywhere the
 * manifest travelled.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key block" },
  { pattern: /postgres(ql)?:\/\/[^\s"]*:[^\s"@]*@/i, label: "database URL with credentials" },
  { pattern: /"password"\s*:/i, label: "password field" },
  { pattern: /"secret"\s*:\s*"(?!\s*$)/i, label: "secret field" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
];

/**
 * Validate a backup manifest.
 *
 * Fails closed: anything unrecognised is an error, because an unreadable
 * manifest during an incident is indistinguishable from no backup at all.
 */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["manifest is not an object"] };
  }

  const candidate = manifest as Partial<BackupManifest>;

  if (candidate.formatVersion !== "1") {
    errors.push(
      `unsupported manifest formatVersion: ${String(candidate.formatVersion)}`,
    );
  }

  if (
    typeof candidate.takenAt !== "string" ||
    Number.isNaN(Date.parse(candidate.takenAt))
  ) {
    errors.push("takenAt is missing or not a valid ISO-8601 timestamp");
  }

  if (
    typeof candidate.migrationVersion !== "string" ||
    candidate.migrationVersion.trim() === ""
  ) {
    errors.push("migrationVersion is missing");
  }

  if (typeof candidate.encrypted !== "boolean") {
    errors.push("encrypted flag is missing");
  }

  // An encrypted backup with no key reference cannot be restored at all. That
  // is precisely the discovery a drill exists to force.
  if (candidate.encrypted === true) {
    if (
      typeof candidate.encryptionKeyId !== "string" ||
      candidate.encryptionKeyId.trim() === ""
    ) {
      errors.push(
        "encrypted backup does not reference an encryptionKeyId; it cannot be restored",
      );
    }
  }

  const domains = candidate.domains;
  if (!Array.isArray(domains)) {
    errors.push("domains is missing");
  } else {
    const present = new Set(domains.map((d) => d?.domain));

    for (const required of RequiredDomains) {
      if (!present.has(required)) {
        // A missing domain means an incoherent restore, which is worse than an
        // obviously failed one because it looks like success.
        errors.push(`required domain "${required}" is absent from the manifest`);
      }
    }

    domains.forEach((domain, index) => {
      if (typeof domain?.rowCount !== "number" || domain.rowCount < 0) {
        errors.push(`domain at index ${index} has an invalid rowCount`);
      }
      if (typeof domain?.checksum !== "string" || domain.checksum === "") {
        errors.push(`domain at index ${index} is missing a checksum`);
      }
    });
  }

  errors.push(...findEmbeddedSecrets(manifest));

  return { valid: errors.length === 0, errors };
}

/**
 * Detect secrets embedded anywhere in a structure.
 *
 * Serialising and pattern-matching catches a secret at any nesting depth,
 * including inside a field somebody added after this check was written — which
 * is the case a field-by-field check would miss.
 */
export function findEmbeddedSecrets(value: unknown): string[] {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return ["value could not be serialised for secret scanning"];
  }

  return FORBIDDEN_PATTERNS.filter(({ pattern }) =>
    pattern.test(serialized),
  ).map(({ label }) => `backup output contains a ${label}`);
}

/** Deterministic checksum over a domain's restored rows. */
export function checksumRows(rows: Array<Record<string, unknown>>): string {
  const canonical = rows
    .map((row) =>
      JSON.stringify(
        Object.keys(row)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = row[key];
            return acc;
          }, {}),
      ),
    )
    .sort()
    .join("|");

  return createHash("sha256").update(canonical).digest("hex");
}

export interface RestoreTarget {
  nodeEnv?: string;
  databaseUrl?: string;
  approved?: string;
}

/** Raised when a restore is attempted against an unapproved target. */
export class UnapprovedRestoreTargetError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to restore: ${reason}. ` +
        "A restore overwrites the target database and cannot be undone.",
    );
    this.name = "UnapprovedRestoreTargetError";
  }
}

/**
 * Decide whether a restore may proceed.
 *
 * Non-destructive by default. A restore overwrites everything in the target, so
 * an accidental one aimed at production destroys the very data the backup exists
 * to protect — turning a recovery tool into the incident.
 *
 * Production therefore requires an explicit, separate approval token rather than
 * a boolean flag that could be set by a stray environment variable.
 */
export function assertRestoreAllowed(target: RestoreTarget): void {
  const databaseUrl = (target.databaseUrl ?? "").trim();

  if (databaseUrl === "") {
    throw new UnapprovedRestoreTargetError("no target database is configured");
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new UnapprovedRestoreTargetError(
      "target database URL could not be parsed",
    );
  }

  const nodeEnv = (target.nodeEnv ?? "").trim().toLowerCase();
  const disposableHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "host.docker.internal",
    "postgres",
    "db",
  ]);

  if (nodeEnv === "production" || !disposableHosts.has(host)) {
    if (target.approved !== "I_UNDERSTAND_THIS_OVERWRITES_DATA") {
      throw new UnapprovedRestoreTargetError(
        `target "${host}" is not a disposable environment and was not explicitly approved`,
      );
    }
  }
}
