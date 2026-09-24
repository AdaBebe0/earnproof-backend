/**
 * Scheduled dry-run: validate the synthetic backup format.
 *
 * This runs in CI without a database. It cannot prove that production backups
 * restore — only a rehearsal against a real dump does that, and the runbook says
 * so plainly. What it does prove is that the manifest format and the drill logic
 * still agree, so the drill is not silently broken on the day it is needed.
 *
 * Run: npm run drill:verify
 */
import {
  UnapprovedRestoreTargetError,
  assertRestoreAllowed,
  validateManifest,
} from "../../src/testing/recovery/backup-manifest";
import {
  RestoredState,
  buildManifestFor,
  runRestoreDrill,
} from "../../src/testing/recovery/restore-drill";

const TAKEN_AT = "2026-01-15T00:00:00.000Z";
const MIGRATION = "20260825170000_make_audit_actor_polymorphic";

/** A small, obviously synthetic snapshot covering every required domain. */
function syntheticState(): RestoredState {
  return {
    migrationVersion: MIGRATION,
    domains: {
      proof_lifecycle: [
        { id: "synthetic_proof_1", status: "ACTIVE" },
        { id: "synthetic_proof_2", status: "REVOKED" },
      ],
      revocation: [{ proofId: "synthetic_proof_2", revokedAt: TAKEN_AT }],
      anchoring_intent: [
        { id: "synthetic_intent_1", proofId: "synthetic_proof_1" },
      ],
      api_keys: [{ id: "synthetic_key_1", prefix: "synth001" }],
      webhooks: [
        { id: "synthetic_hook_1", url: "https://synthetic.example.invalid/h" },
      ],
    },
  };
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function main(): void {
  const state = syntheticState();
  const manifest = buildManifestFor(state, {
    takenAt: TAKEN_AT,
    encryptionKeyId: "kms://synthetic-key-ref",
  });

  const validation = validateManifest(manifest);
  if (!validation.valid) {
    fail(`synthetic manifest is invalid: ${validation.errors.join("; ")}`);
  }
  console.log("ok: synthetic manifest validates");

  const clean = runRestoreDrill(manifest, state);
  if (!clean.passed) {
    fail(
      `drill rejected a known-good restore: ${clean.findings
        .map((f) => f.message)
        .join("; ")}`,
    );
  }
  console.log("ok: drill accepts a coherent restore");

  // Negative control. A drill that cannot fail proves nothing, so the dry-run
  // deliberately corrupts the restore and requires the drill to notice.
  const corrupted: RestoredState = {
    ...state,
    domains: {
      ...state.domains,
      // A revoked proof restored as ACTIVE — the failure that reports success.
      proof_lifecycle: [
        { id: "synthetic_proof_1", status: "ACTIVE" },
        { id: "synthetic_proof_2", status: "ACTIVE" },
      ],
    },
  };

  const detected = runRestoreDrill(manifest, corrupted);
  if (detected.passed) {
    fail("drill did NOT detect a revoked proof restored in an active state");
  }
  console.log("ok: drill detects an incoherent restore");

  // The refusal path must hold, or the drill becomes a way to overwrite a real
  // database.
  try {
    assertRestoreAllowed({
      nodeEnv: "production",
      databaseUrl: "postgresql://user:pass@db.example.com:5432/app",
    });
    fail("restore guard did NOT refuse an unapproved production target");
  } catch (error) {
    if (!(error instanceof UnapprovedRestoreTargetError)) {
      throw error;
    }
    console.log("ok: restore guard refuses an unapproved target");
  }

  console.log("\nBackup format dry-run passed.");
}

main();
