import {
  ChangeKind,
  CompatibilityNote,
  ContractDefinition,
  ContractSurface,
  diffContracts,
  findPolicyViolations,
} from "./contract-snapshot";

/**
 * Policy-check fixture.
 *
 * The required demonstration is that an UNDOCUMENTED BREAKING CHANGE is
 * detected. Everything else here exists to prove the check is not simply
 * flagging everything: additive changes must pass cleanly, or the check gets
 * ignored and stops protecting anything.
 *
 * Contracts are modelled on the repository's real surfaces — the `api/v1` REST
 * prefix, `earnproof.minimum-income.v1` credentials, and the `specVersion: "1"`
 * webhook envelope.
 */

const restProofContract: ContractDefinition = {
  surface: ContractSurface.REST,
  id: "GET /api/v1/proofs/:id",
  version: "v1",
  fields: [
    { name: "proofId", required: true },
    { name: "status", required: true },
    { name: "expiresAt", required: true },
    { name: "contractTransactionHash", required: false },
  ],
};

const webhookEnvelopeContract: ContractDefinition = {
  surface: ContractSurface.WEBHOOK,
  id: "webhook.envelope",
  version: "1",
  fields: [
    { name: "specVersion", required: true },
    { name: "id", required: true },
    { name: "event", required: true },
    { name: "createdAt", required: true },
    { name: "data", required: true },
  ],
};

const credentialContract: ContractDefinition = {
  surface: ContractSurface.CREDENTIAL,
  id: "earnproof.minimum-income",
  version: "v1",
  fields: [
    { name: "schemaVersion", required: true },
    { name: "credentialHash", required: true },
    { name: "issuedAt", required: true },
  ],
};

const baseline = [
  restProofContract,
  webhookEnvelopeContract,
  credentialContract,
];

function withFields(
  contract: ContractDefinition,
  fields: ContractDefinition["fields"],
): ContractDefinition {
  return { ...contract, fields };
}

describe("contract change detection", () => {
  describe("breaking changes", () => {
    it("flags a removed field", () => {
      // The canonical break: a consumer reading this field now gets undefined.
      const after = baseline.map((contract) =>
        contract.id === restProofContract.id
          ? withFields(
              contract,
              contract.fields.filter((f) => f.name !== "expiresAt"),
            )
          : contract,
      );

      const changes = diffContracts(baseline, after);

      expect(changes).toContainEqual(
        expect.objectContaining({
          kind: ChangeKind.BREAKING,
          description: 'field "expiresAt" was removed',
        }),
      );
    });

    it("flags removal of an optional field", () => {
      // Optional still means a consumer may read it.
      const after = baseline.map((contract) =>
        contract.id === restProofContract.id
          ? withFields(
              contract,
              contract.fields.filter(
                (f) => f.name !== "contractTransactionHash",
              ),
            )
          : contract,
      );

      expect(diffContracts(baseline, after)).toContainEqual(
        expect.objectContaining({ kind: ChangeKind.BREAKING }),
      );
    });

    it("flags a newly required field", () => {
      // Existing callers do not send it, so their requests start failing.
      const after = baseline.map((contract) =>
        contract.id === restProofContract.id
          ? withFields(contract, [
              ...contract.fields,
              { name: "requesterId", required: true },
            ])
          : contract,
      );

      expect(diffContracts(baseline, after)).toContainEqual(
        expect.objectContaining({
          kind: ChangeKind.BREAKING,
          description: 'required field "requesterId" was added',
        }),
      );
    });

    it("flags an optional field becoming required", () => {
      const after = baseline.map((contract) =>
        contract.id === restProofContract.id
          ? withFields(
              contract,
              contract.fields.map((f) =>
                f.name === "contractTransactionHash"
                  ? { ...f, required: true }
                  : f,
              ),
            )
          : contract,
      );

      expect(diffContracts(baseline, after)).toContainEqual(
        expect.objectContaining({
          kind: ChangeKind.BREAKING,
          description: 'field "contractTransactionHash" became required',
        }),
      );
    });

    it("flags a removed contract", () => {
      const after = baseline.filter((c) => c.id !== webhookEnvelopeContract.id);

      expect(diffContracts(baseline, after)).toContainEqual(
        expect.objectContaining({
          kind: ChangeKind.BREAKING,
          description: 'contract "webhook.envelope" was removed',
        }),
      );
    });
  });

  describe("additive changes", () => {
    it("treats a new optional field as additive", () => {
      const after = baseline.map((contract) =>
        contract.id === restProofContract.id
          ? withFields(contract, [
              ...contract.fields,
              { name: "revokedAt", required: false },
            ])
          : contract,
      );

      const changes = diffContracts(baseline, after);

      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe(ChangeKind.ADDITIVE);
    });

    it("treats a new contract as additive", () => {
      const after = [
        ...baseline,
        {
          surface: ContractSurface.REST,
          id: "GET /api/v1/proofs/:id/history",
          version: "v1",
          fields: [{ name: "entries", required: true }],
        },
      ];

      const changes = diffContracts(baseline, after);

      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe(ChangeKind.ADDITIVE);
    });

    it("reports no changes when nothing moved", () => {
      // A check that fires on an unchanged surface would be ignored within a
      // week, and then it protects nothing.
      expect(diffContracts(baseline, baseline)).toEqual([]);
    });
  });
});

describe("policy enforcement", () => {
  const breakingChange = () =>
    diffContracts(
      baseline,
      baseline.map((contract) =>
        contract.id === webhookEnvelopeContract.id
          ? withFields(
              contract,
              contract.fields.filter((f) => f.name !== "createdAt"),
            )
          : contract,
      ),
    );

  it("detects an undocumented breaking change", () => {
    // This is the required demonstration: a breaking change shipped with no
    // compatibility note is exactly the failure the policy exists to catch.
    const violations = findPolicyViolations(breakingChange(), []);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      contractId: "webhook.envelope",
      surface: ContractSurface.WEBHOOK,
    });
    expect(violations[0].reason).toContain("undocumented breaking change");
  });

  it("accepts a breaking change that carries a compatibility note", () => {
    const note: CompatibilityNote = {
      contractId: "webhook.envelope",
      migration:
        "Read createdAt from the delivery metadata header instead of the envelope body.",
      supportWindowEndsAt: "2026-06-01",
      approvedBy: "maintainers",
    };

    expect(findPolicyViolations(breakingChange(), [note])).toHaveLength(0);
  });

  it("accepts a breaking change behind a version increment", () => {
    // Moving consumers to a new version IS the compatibility mechanism, so a
    // documented note is not additionally required.
    expect(
      findPolicyViolations(breakingChange(), [], {
        versionedContractIds: ["webhook.envelope"],
      }),
    ).toHaveLength(0);
  });

  it("never flags additive changes", () => {
    const additive = diffContracts(
      baseline,
      baseline.map((contract) =>
        contract.id === credentialContract.id
          ? withFields(contract, [
              ...contract.fields,
              { name: "issuerHint", required: false },
            ])
          : contract,
      ),
    );

    expect(findPolicyViolations(additive, [])).toHaveLength(0);
  });

  it("reports every undocumented break, not just the first", () => {
    // A check that stopped at the first violation would send a contributor
    // through as many review cycles as they have breaks.
    const after = baseline.map((contract) =>
      withFields(contract, contract.fields.slice(1)),
    );

    const violations = findPolicyViolations(diffContracts(baseline, after), []);

    expect(violations.length).toBeGreaterThanOrEqual(3);
  });

  it("does not expose usage data when reporting a violation", () => {
    // Deprecation telemetry must measure the contract, never who called it:
    // "which consumers still use this field" is a question about identifiable
    // integrator behaviour.
    const violations = findPolicyViolations(breakingChange(), []);
    const serialized = JSON.stringify(violations);

    expect(serialized).not.toMatch(/organization|apiKey|userId|caller|ip/i);
  });
});
