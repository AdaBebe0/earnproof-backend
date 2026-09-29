/**
 * Allowlisted webhook event types.
 *
 * Only these values may appear in Webhook.events or be used to
 * filter subscriptions. Arbitrary/unvalidated event names are rejected
 * at the DTO layer.
 */
export const WEBHOOK_EVENT_TYPES = [
  "proof.created",
  "proof.revoked",
  "proof.verified",
  "attestation.expired",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * Payload schema versions this service can serialize.
 *
 * A version is removed from this list only after its deprecation window has
 * elapsed (see docs/webhook-payloads.md). Endpoints pinned to a removed version
 * stop receiving events rather than receiving a shape they did not agree to.
 */
export const WEBHOOK_PAYLOAD_VERSIONS = ["1"] as const;

export type WebhookPayloadVersion = (typeof WEBHOOK_PAYLOAD_VERSIONS)[number];

/** Version assigned to newly created endpoints that do not request one. */
export const CURRENT_WEBHOOK_PAYLOAD_VERSION: WebhookPayloadVersion = "1";

// ---------------------------------------------------------------------------
// Domain sources — what the emitting module hands to the webhook module.
//
// These are deliberately plain snapshots, not Prisma model types: the payload
// contract must not change because a column was added to `Proof`. Serializers
// copy named fields out of a source; nothing on a source is forwarded
// implicitly.
// ---------------------------------------------------------------------------

export interface ProofCreatedSource {
  proofId: string;
  proofType: string;
  /** Credential schema identifier, e.g. `earnproof.minimum-income.v1`. */
  credentialSchemaVersion: string;
  status: string;
  network: string;
  assetCode: string;
  assetIssuer: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  expiresAt: Date;
  credentialHash: string;
  contractTransactionHash: string | null;
  issuedAt: Date;
}

export interface ProofRevokedSource {
  proofId: string;
  status: string;
  revokedAt: Date;
}

export interface ProofVerifiedSource {
  proofId: string;
  result: string;
  verifiedAt: Date;
}

export interface WebhookEventSources {
  "proof.created": ProofCreatedSource;
  "proof.revoked": ProofRevokedSource;
  "proof.verified": ProofVerifiedSource;
}

/** A domain event awaiting fan-out to subscribed endpoints. */
export type WebhookEventSource = {
  [E in WebhookEventType]: { event: E; source: WebhookEventSources[E] };
}[WebhookEventType];

// ---------------------------------------------------------------------------
// Version 1 payload shapes — only public / non-sensitive fields are included.
// Private proof inputs (source transactions, exact aggregate income,
// threshold values, encrypted fields) must NEVER appear here.
// ---------------------------------------------------------------------------

export interface ProofCreatedPayload {
  proofId: string;
  proofType: string;
  schemaVersion: string;
  status: string;
  network: string;
  assetCode: string;
  /** null when asset is the native asset */
  assetIssuer: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  expiresAt: string;
  credentialHash: string;
  /** present only when contract anchoring is enabled */
  contractTransactionHash: string | null;
  issuedAt: string;
}

export interface ProofRevokedPayload {
  proofId: string;
  status: string;
  revokedAt: string;
}

export interface ProofVerifiedPayload {
  proofId: string;
  result: string;
  verifiedAt: string;
}

export interface AttestationExpiredPayload {
  attestationId: string;
  issuerId: string;
  /** Hashed subject identifier — never a raw wallet address. */
  subjectWalletHash: string;
  /** Stored status before reconciliation moved it. */
  previousStatus: string;
  /** Effective status after reconciliation — "EXPIRED". */
  effectiveStatus: string;
  expiresAt: string;
  reconciledAt: string;
}

export type WebhookEventPayload =
  | { event: "proof.created"; data: ProofCreatedPayload }
  | { event: "proof.revoked"; data: ProofRevokedPayload }
  | { event: "proof.verified"; data: ProofVerifiedPayload }
  | { event: "attestation.expired"; data: AttestationExpiredPayload };

/**
 * The versioned envelope sent to every webhook endpoint.
 *
 * - `specVersion` versions the envelope itself.
 * - `schemaVersion` versions `data` for this `event`; the pair
 *   (`event`, `schemaVersion`) identifies the payload contract.
 * - `id` is the stable event identifier: identical across every endpoint,
 *   retry, replay, and redrive of the same domain event. Integrators
 *   deduplicate on it.
 */
export interface WebhookEnvelope<E extends WebhookEventType = WebhookEventType> {
  specVersion: "1";
  id: string; // delivery eventId — idempotency key for the integrator
  event: WebhookEventType;
  createdAt: string; // ISO-8601
  data:
    | ProofCreatedPayload
    | ProofRevokedPayload
    | ProofVerifiedPayload
    | AttestationExpiredPayload;
}
