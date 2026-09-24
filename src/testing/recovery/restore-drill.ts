import {
  BackupManifest,
  DomainSnapshot,
  RequiredDomain,
  RequiredDomains,
  checksumRows,
  findEmbeddedSecrets,
} from "./backup-manifest";

/**
 * Synthetic restore verification.
 *
 * The drill answers one question: after restoring this backup, is the system
 * coherent? Row counts alone cannot answer it — a restore can produce the right
 * number of rows in every table and still be wrong, if for example proofs came
 * from a later snapshot than the revocations that withdraw them.
 */

/** The restored state a drill inspects. */
export interface RestoredState {
  migrationVersion: string;
  domains: Record<RequiredDomain, Array<Record<string, unknown>>>;
}

export interface DrillFinding {
  severity: "error" | "warning";
  domain: RequiredDomain | "schema" | "output";
  message: string;
}

export interface DrillResult {
  passed: boolean;
  findings: DrillFinding[];
}

/**
 * Verify a restored database against the manifest that described the backup.
 *
 * Checks, and the failure each one catches:
 *
 * 1. Migration parity — restoring into a schema at a different migration is
 *    silent corruption.
 * 2. Row counts — a truncated dump.
 * 3. Checksums — content drift that row counts cannot see.
 * 4. Proof/revocation coherence — the dangerous partial restore.
 * 5. Anchoring intent references — orphaned intents.
 * 6. Secret leakage — a restore report that spreads credentials.
 */
export function runRestoreDrill(
  manifest: BackupManifest,
  restored: RestoredState,
): DrillResult {
  const findings: DrillFinding[] = [];

  if (manifest.migrationVersion !== restored.migrationVersion) {
    findings.push({
      severity: "error",
      domain: "schema",
      message:
        `restored schema is at migration "${restored.migrationVersion}" but the backup ` +
        `was taken at "${manifest.migrationVersion}"; constraints may differ`,
    });
  }

  const manifestByDomain = new Map<RequiredDomain, DomainSnapshot>(
    manifest.domains.map((domain) => [domain.domain, domain]),
  );

  for (const domain of RequiredDomains) {
    const expected = manifestByDomain.get(domain);
    const rows = restored.domains[domain];

    if (!expected) {
      findings.push({
        severity: "error",
        domain,
        message: `manifest does not describe domain "${domain}"`,
      });
      continue;
    }

    if (!Array.isArray(rows)) {
      findings.push({
        severity: "error",
        domain,
        message: `domain "${domain}" is absent from the restored database`,
      });
      continue;
    }

    if (rows.length !== expected.rowCount) {
      findings.push({
        severity: "error",
        domain,
        message: `domain "${domain}" restored ${rows.length} rows, manifest expected ${expected.rowCount}`,
      });
      continue;
    }

    const actualChecksum = checksumRows(rows);
    if (actualChecksum !== expected.checksum) {
      // Row counts can match while content differs — this is what catches that.
      findings.push({
        severity: "error",
        domain,
        message: `domain "${domain}" checksum mismatch; restored content differs from the backup`,
      });
    }
  }

  findings.push(...verifyRevocationCoherence(restored));
  findings.push(...verifyAnchoringReferences(restored));

  findEmbeddedSecrets(manifest).forEach((message) => {
    findings.push({ severity: "error", domain: "output", message });
  });

  return {
    passed: findings.every((finding) => finding.severity !== "error"),
    findings,
  };
}

/**
 * Verify no revoked proof was restored in an active state.
 *
 * This is the check that matters most. A restore that loses revocations produces
 * a system that will confidently verify credentials their issuers already
 * withdrew — and unlike a failed restore, it reports success.
 */
function verifyRevocationCoherence(restored: RestoredState): DrillFinding[] {
  const revokedIds = new Set(
    (restored.domains.revocation ?? [])
      .map((row) => row["proofId"])
      .filter((id): id is string => typeof id === "string"),
  );

  return (restored.domains.proof_lifecycle ?? [])
    .filter((proof) => {
      const id = proof["id"];
      return typeof id === "string" && revokedIds.has(id);
    })
    .filter((proof) => proof["status"] !== "REVOKED")
    .map((proof) => ({
      severity: "error" as const,
      domain: "proof_lifecycle" as const,
      message:
        `proof "${String(proof["id"])}" has a revocation record but restored with status ` +
        `"${String(proof["status"])}"; it would verify as valid`,
    }));
}

/** Verify every anchoring intent references a restored proof. */
function verifyAnchoringReferences(restored: RestoredState): DrillFinding[] {
  const proofIds = new Set(
    (restored.domains.proof_lifecycle ?? [])
      .map((row) => row["id"])
      .filter((id): id is string => typeof id === "string"),
  );

  return (restored.domains.anchoring_intent ?? [])
    .filter((intent) => {
      const proofId = intent["proofId"];
      return typeof proofId === "string" && !proofIds.has(proofId);
    })
    .map((intent) => ({
      severity: "error" as const,
      domain: "anchoring_intent" as const,
      message: `anchoring intent references proof "${String(intent["proofId"])}" which was not restored`,
    }));
}

/**
 * Build a manifest describing a known state.
 *
 * Used by the dry-run to produce a backup whose correctness is known in advance,
 * so the drill itself can be validated. A drill that has never been shown to
 * fail is not evidence of anything.
 */
export function buildManifestFor(
  restored: RestoredState,
  options: { takenAt: string; encryptionKeyId?: string | null },
): BackupManifest {
  return {
    formatVersion: "1",
    takenAt: options.takenAt,
    migrationVersion: restored.migrationVersion,
    encrypted: options.encryptionKeyId != null,
    encryptionKeyId: options.encryptionKeyId ?? null,
    domains: RequiredDomains.map((domain) => ({
      domain,
      rowCount: restored.domains[domain]?.length ?? 0,
      checksum: checksumRows(restored.domains[domain] ?? []),
    })),
  };
}
