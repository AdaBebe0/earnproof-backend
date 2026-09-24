import {
  RequiredDomains,
  UnapprovedRestoreTargetError,
  assertRestoreAllowed,
  checksumRows,
  findEmbeddedSecrets,
  validateManifest,
} from "./backup-manifest";
import {
  RestoredState,
  buildManifestFor,
  runRestoreDrill,
} from "./restore-drill";

/**
 * Disaster-recovery drill.
 *
 * The point is not to assert the drill passes on good input — that proves very
 * little. Each scenario below breaks the restore in a specific way and asserts
 * the drill NOTICES. A drill that has never been shown to fail is not evidence
 * that backups are restorable.
 */

const TAKEN_AT = "2026-01-15T00:00:00.000Z";
const MIGRATION = "20260825170000_make_audit_actor_polymorphic";

function healthyState(): RestoredState {
  return {
    migrationVersion: MIGRATION,
    domains: {
      proof_lifecycle: [
        { id: "proof_1", status: "ACTIVE", credentialHash: "sha256:synthetic-1" },
        { id: "proof_2", status: "REVOKED", credentialHash: "sha256:synthetic-2" },
      ],
      revocation: [{ proofId: "proof_2", revokedAt: TAKEN_AT }],
      anchoring_intent: [
        { id: "intent_1", proofId: "proof_1", status: "CONFIRMED" },
      ],
      api_keys: [{ id: "key_1", prefix: "synth001", status: "ACTIVE" }],
      webhooks: [{ id: "hook_1", url: "https://synthetic.example.invalid/h" }],
    },
  };
}

function manifestFor(state: RestoredState) {
  return buildManifestFor(state, {
    takenAt: TAKEN_AT,
    encryptionKeyId: "kms://synthetic-key-ref",
  });
}

describe("backup manifest validation", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifestFor(healthyState()))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects a manifest that is not an object", () => {
    expect(validateManifest("not a manifest").valid).toBe(false);
    expect(validateManifest(null).valid).toBe(false);
  });

  it("rejects an unsupported format version", () => {
    // An unreadable manifest during an incident is indistinguishable from
    // having no backup at all, so this fails closed.
    const manifest = { ...manifestFor(healthyState()), formatVersion: "2" };

    expect(validateManifest(manifest).errors).toContainEqual(
      expect.stringContaining("unsupported manifest formatVersion"),
    );
  });

  it("rejects an encrypted backup with no key reference", () => {
    // The discovery this exists to force: an encrypted dump nobody can decrypt.
    const manifest = {
      ...manifestFor(healthyState()),
      encrypted: true,
      encryptionKeyId: null,
    };

    expect(validateManifest(manifest).errors).toContainEqual(
      expect.stringContaining("cannot be restored"),
    );
  });

  it("rejects a manifest missing a required domain", () => {
    const manifest = manifestFor(healthyState());
    manifest.domains = manifest.domains.filter(
      (domain) => domain.domain !== "revocation",
    );

    expect(validateManifest(manifest).errors).toContainEqual(
      expect.stringContaining('required domain "revocation" is absent'),
    );
  });

  it("requires every domain the runbook promises to restore", () => {
    expect(RequiredDomains).toEqual([
      "proof_lifecycle",
      "revocation",
      "anchoring_intent",
      "api_keys",
      "webhooks",
    ]);
  });

  it("rejects an invalid timestamp", () => {
    const manifest = { ...manifestFor(healthyState()), takenAt: "yesterday" };

    expect(validateManifest(manifest).valid).toBe(false);
  });
});

describe("secret containment", () => {
  it("rejects a manifest embedding a database URL with credentials", () => {
    // Manifests travel into runbooks, tickets, and CI logs.
    const manifest = {
      ...manifestFor(healthyState()),
      note: "restore from postgresql://admin:hunter2@prod.example.com:5432/app",
    };

    expect(validateManifest(manifest).errors).toContainEqual(
      expect.stringContaining("database URL with credentials"),
    );
  });

  it("rejects a manifest embedding a private key", () => {
    const manifest = {
      ...manifestFor(healthyState()),
      key: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n",
    };

    expect(validateManifest(manifest).errors).toContainEqual(
      expect.stringContaining("private key block"),
    );
  });

  it("detects secrets nested at any depth", () => {
    // A field-by-field check would miss a secret added to a nested object after
    // the check was written.
    const nested = { a: { b: { c: { aws: "AKIAIOSFODNN7EXAMPLE" } } } };

    expect(findEmbeddedSecrets(nested)).toContainEqual(
      expect.stringContaining("AWS access key id"),
    );
  });

  it("permits a key IDENTIFIER, which is not itself a secret", () => {
    // The whole encryption model depends on this distinction: the manifest
    // references the key, the key manager holds it.
    const manifest = manifestFor(healthyState());

    expect(manifest.encryptionKeyId).toBe("kms://synthetic-key-ref");
    expect(validateManifest(manifest).valid).toBe(true);
  });
});

describe("restore drill", () => {
  it("passes on a coherent restore", () => {
    const state = healthyState();

    expect(runRestoreDrill(manifestFor(state), state)).toEqual({
      passed: true,
      findings: [],
    });
  });

  it("detects a schema/migration mismatch", () => {
    // Restoring into a different schema is silent corruption: constraints the
    // dump relied on may not exist.
    const state = healthyState();
    const manifest = manifestFor(state);

    const result = runRestoreDrill(manifest, {
      ...state,
      migrationVersion: "20260713210000_phase1_persistence",
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ domain: "schema" }),
    );
  });

  it("detects a truncated restore", () => {
    const state = healthyState();
    const manifest = manifestFor(state);

    const truncated: RestoredState = {
      ...state,
      domains: { ...state.domains, api_keys: [] },
    };

    const result = runRestoreDrill(manifest, truncated);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        domain: "api_keys",
        message: expect.stringContaining("restored 0 rows"),
      }),
    );
  });

  it("detects content drift that row counts cannot see", () => {
    const state = healthyState();
    const manifest = manifestFor(state);

    const drifted: RestoredState = {
      ...state,
      domains: {
        ...state.domains,
        webhooks: [
          { id: "hook_1", url: "https://attacker.example.invalid/h" },
        ],
      },
    };

    const result = runRestoreDrill(manifest, drifted);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        domain: "webhooks",
        message: expect.stringContaining("checksum mismatch"),
      }),
    );
  });

  it("detects a proof restored active despite an existing revocation", () => {
    // The most dangerous partial restore: it reports success while the system
    // will verify a credential its issuer already withdrew.
    const state = healthyState();
    state.domains.proof_lifecycle = [
      { id: "proof_1", status: "ACTIVE", credentialHash: "sha256:synthetic-1" },
      { id: "proof_2", status: "ACTIVE", credentialHash: "sha256:synthetic-2" },
    ];

    const manifest = manifestFor(state);
    const result = runRestoreDrill(manifest, state);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        domain: "proof_lifecycle",
        message: expect.stringContaining("would verify as valid"),
      }),
    );
  });

  it("detects an orphaned anchoring intent", () => {
    const state = healthyState();
    state.domains.anchoring_intent = [
      { id: "intent_9", proofId: "proof_missing", status: "PENDING" },
    ];

    const result = runRestoreDrill(manifestFor(state), state);

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ domain: "anchoring_intent" }),
    );
  });

  it("reports every problem rather than stopping at the first", () => {
    // An operator mid-incident needs the whole picture, not one problem per run.
    const state = healthyState();
    const manifest = manifestFor(state);

    const broken: RestoredState = {
      migrationVersion: "wrong_migration",
      domains: { ...state.domains, api_keys: [], webhooks: [] },
    };

    const result = runRestoreDrill(manifest, broken);

    expect(result.findings.length).toBeGreaterThanOrEqual(3);
  });
});

describe("checksums", () => {
  it("is order-independent, since row order is not guaranteed by a restore", () => {
    const rows = [{ id: "a" }, { id: "b" }];

    expect(checksumRows(rows)).toBe(checksumRows([...rows].reverse()));
  });

  it("is key-order independent", () => {
    expect(checksumRows([{ a: 1, b: 2 }])).toBe(checksumRows([{ b: 2, a: 1 }]));
  });

  it("changes when content changes", () => {
    expect(checksumRows([{ id: "a" }])).not.toBe(checksumRows([{ id: "b" }]));
  });
});

describe("restore target approval", () => {
  it("allows a disposable local target", () => {
    expect(() =>
      assertRestoreAllowed({
        nodeEnv: "test",
        databaseUrl: "postgresql://u:p@localhost:5432/drill",
      }),
    ).not.toThrow();
  });

  it("refuses production without explicit approval", () => {
    // A restore overwrites everything in the target. An accidental one aimed at
    // production destroys the data the backup exists to protect.
    expect(() =>
      assertRestoreAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://u:p@localhost:5432/app",
      }),
    ).toThrow(UnapprovedRestoreTargetError);
  });

  it("refuses a remote target without explicit approval", () => {
    expect(() =>
      assertRestoreAllowed({
        nodeEnv: "staging",
        databaseUrl: "postgresql://u:p@db.example.com:5432/app",
      }),
    ).toThrow(UnapprovedRestoreTargetError);
  });

  it("requires the exact approval token, not a truthy flag", () => {
    // A boolean could be set by a stray environment variable; a specific phrase
    // has to be typed deliberately.
    expect(() =>
      assertRestoreAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://u:p@db.example.com:5432/app",
        approved: "true",
      }),
    ).toThrow(UnapprovedRestoreTargetError);

    expect(() =>
      assertRestoreAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://u:p@db.example.com:5432/app",
        approved: "I_UNDERSTAND_THIS_OVERWRITES_DATA",
      }),
    ).not.toThrow();
  });

  it("refuses when no target is configured", () => {
    expect(() => assertRestoreAllowed({ nodeEnv: "test" })).toThrow(
      UnapprovedRestoreTargetError,
    );
  });

  it("never echoes the target password in a refusal", () => {
    try {
      assertRestoreAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://admin:hunter2@db.example.com:5432/app",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});
