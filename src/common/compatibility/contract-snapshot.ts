/**
 * Public-contract surface tracking.
 *
 * Four surfaces are consumed by parties who do not deploy in lockstep with this
 * service: REST routes and DTOs, credential schemas, webhook envelopes, and
 * contract-facing payloads. A change that is trivial in the codebase can break
 * every one of those consumers silently, and the breakage shows up as a support
 * ticket weeks later rather than as a failing build.
 *
 * This module makes the surface explicit so a change to it is visible in review
 * rather than inferred from a diff.
 */

/** The kinds of public contract this service exposes. */
export const ContractSurface = {
  REST: "rest",
  CREDENTIAL: "credential",
  WEBHOOK: "webhook",
  CONTRACT_BINDING: "contract_binding",
} as const;

export type ContractSurfaceValue =
  (typeof ContractSurface)[keyof typeof ContractSurface];

/**
 * Classification of a change to a public contract.
 *
 * The distinction is not stylistic. ADDITIVE changes are safe to ship to
 * existing consumers without warning; BREAKING changes are not, and shipping one
 * unannounced is what turns an ordinary release into an outage for integrators.
 */
export const ChangeKind = {
  /** Existing consumers keep working unchanged. */
  ADDITIVE: "additive",
  /** Existing consumers can stop working. */
  BREAKING: "breaking",
} as const;

export type ChangeKindValue = (typeof ChangeKind)[keyof typeof ChangeKind];

/** A single field within a contract. */
export interface ContractField {
  name: string;
  /** Whether a consumer can rely on this field always being present. */
  required: boolean;
}

/** A versioned public contract. */
export interface ContractDefinition {
  surface: ContractSurfaceValue;
  /** Stable identifier, e.g. "GET /api/v1/proofs/:id" or "webhook.envelope". */
  id: string;
  version: string;
  fields: ContractField[];
}

/** A detected difference between two snapshots of the same contract. */
export interface ContractChange {
  surface: ContractSurfaceValue;
  contractId: string;
  kind: ChangeKindValue;
  description: string;
}

/**
 * Compare two snapshots of the public contract surface.
 *
 * The classification rules, and why each one is what it is:
 *
 * - Removing a contract entirely is BREAKING. Every consumer of it stops.
 * - Removing a field is BREAKING, even an optional one: a consumer that reads it
 *   gets `undefined` where it previously got a value.
 * - Adding a REQUIRED field is BREAKING for request contracts, because existing
 *   callers do not send it. Adding an OPTIONAL field is additive.
 * - Making an optional field required is BREAKING — same reason.
 * - Making a required field optional is ADDITIVE for callers, but consumers that
 *   assumed presence may now see `undefined`, so it is reported rather than
 *   silently ignored.
 * - Changing a version string is reported so a reviewer can confirm the increment
 *   was deliberate.
 */
export function diffContracts(
  before: ContractDefinition[],
  after: ContractDefinition[],
): ContractChange[] {
  const changes: ContractChange[] = [];
  const afterById = new Map(after.map((c) => [c.id, c]));
  const beforeById = new Map(before.map((c) => [c.id, c]));

  for (const previous of before) {
    const current = afterById.get(previous.id);

    if (!current) {
      changes.push({
        surface: previous.surface,
        contractId: previous.id,
        kind: ChangeKind.BREAKING,
        description: `contract "${previous.id}" was removed`,
      });
      continue;
    }

    if (previous.version !== current.version) {
      changes.push({
        surface: current.surface,
        contractId: current.id,
        kind: ChangeKind.ADDITIVE,
        description: `version changed from ${previous.version} to ${current.version}`,
      });
    }

    const previousFields = new Map(previous.fields.map((f) => [f.name, f]));
    const currentFields = new Map(current.fields.map((f) => [f.name, f]));

    for (const [name, field] of previousFields) {
      const stillPresent = currentFields.get(name);

      if (!stillPresent) {
        // Optional fields count too: a consumer reading one now gets undefined.
        changes.push({
          surface: current.surface,
          contractId: current.id,
          kind: ChangeKind.BREAKING,
          description: `field "${name}" was removed`,
        });
        continue;
      }

      if (!field.required && stillPresent.required) {
        changes.push({
          surface: current.surface,
          contractId: current.id,
          kind: ChangeKind.BREAKING,
          description: `field "${name}" became required`,
        });
      }

      if (field.required && !stillPresent.required) {
        changes.push({
          surface: current.surface,
          contractId: current.id,
          kind: ChangeKind.ADDITIVE,
          description: `field "${name}" became optional`,
        });
      }
    }

    for (const [name, field] of currentFields) {
      if (previousFields.has(name)) {
        continue;
      }

      changes.push({
        surface: current.surface,
        contractId: current.id,
        kind: field.required ? ChangeKind.BREAKING : ChangeKind.ADDITIVE,
        description: field.required
          ? `required field "${name}" was added`
          : `optional field "${name}" was added`,
      });
    }
  }

  for (const current of after) {
    if (!beforeById.has(current.id)) {
      changes.push({
        surface: current.surface,
        contractId: current.id,
        kind: ChangeKind.ADDITIVE,
        description: `contract "${current.id}" was added`,
      });
    }
  }

  return changes;
}

/**
 * A compatibility note accompanying a change.
 *
 * Required for every breaking change. Its absence is the condition the policy
 * check fails on.
 */
export interface CompatibilityNote {
  contractId: string;
  /** Why the break was necessary and what consumers must do. */
  migration: string;
  /** When support for the previous behaviour ends. */
  supportWindowEndsAt: string;
  /** Who approved the removal. */
  approvedBy: string;
}

export interface PolicyViolation {
  contractId: string;
  surface: ContractSurfaceValue;
  reason: string;
}

/**
 * Verify every breaking change carries a compatibility note.
 *
 * This is the mechanical part of the policy — the part CI can enforce. It cannot
 * judge whether a migration guide is any good, but it can guarantee that
 * somebody was made to write one, which is the failure mode that actually
 * recurs: a breaking change shipped because nobody noticed it was breaking.
 *
 * A version increment on the contract is accepted in place of a note, because
 * moving consumers to a new version is itself the compatibility mechanism.
 */
export function findPolicyViolations(
  changes: ContractChange[],
  notes: CompatibilityNote[],
  options: { versionedContractIds?: string[] } = {},
): PolicyViolation[] {
  const documented = new Set(notes.map((note) => note.contractId));
  const versioned = new Set(options.versionedContractIds ?? []);

  return changes
    .filter((change) => change.kind === ChangeKind.BREAKING)
    .filter(
      (change) =>
        !documented.has(change.contractId) && !versioned.has(change.contractId),
    )
    .map((change) => ({
      contractId: change.contractId,
      surface: change.surface,
      reason: `undocumented breaking change: ${change.description}`,
    }));
}
