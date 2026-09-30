import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WebhookDeliveryStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import {
  WEBHOOK_TEST_EVENT_ID_PREFIX,
  WEBHOOK_TEST_EVENT_TYPE,
  WEBHOOK_TEST_EVENT_VERSION,
  WebhookEnvelope,
  WebhookEventType,
  WebhookTestEnvelope,
} from "./webhook-event.types";
import { WebhookSigningService } from "./webhook-signing.service";
import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
} from "./webhook-ssrf-guard";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";

/** Maximum stored response body size in bytes (1 KiB). */
const MAX_RESPONSE_BODY_BYTES = 1024;

/** Delivery timeout in milliseconds. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Maximum delivery attempts (1 initial + 4 retries = 5 total). */
const MAX_ATTEMPTS = 5;

/** Exponential backoff base in milliseconds. */
const BACKOFF_BASE_MS = 1_000;

/**
 * Compute delay before attempt `n` (1-indexed).
 * Attempt 1 = immediate (no delay).
 * Attempt 2 = 1 s, 3 = 2 s, 4 = 4 s, 5 = 8 s.
 */
function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return BACKOFF_BASE_MS * Math.pow(2, attempt - 2);
}

/**
 * Per-webhook serialization queue.
 *
 * Deliveries for the same webhook endpoint are chained on a single
 * Promise so they execute strictly in FIFO order and never interleave.
 * This enforces ordering guarantees per aggregate (webhook endpoint).
 */
type WebhookChain = { tail: Promise<void> };

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new StructuredLogger(WebhookDeliveryService.name);
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  /**
   * Per-webhook serialization chains.
   * Key = webhookId, value = chain whose `tail` is the last enqueued delivery.
   */
  private readonly chains = new Map<string, WebhookChain>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
    private readonly circuitBreaker: WebhookCircuitBreakerService,
    configService: ConfigService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  /**
   * On startup, re-enqueue any deliveries that were PENDING when the process
   * last shut down (handles crash recovery).
   */
  async onModuleInit(): Promise<void> {
    const pending = await this.prisma.webhookDelivery.findMany({
      where: { status: WebhookDeliveryStatus.PENDING },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        webhookId: true,
        attempt: true,
        nextRetryAt: true,
      },
    });

    for (const delivery of pending) {
      const delay = delivery.nextRetryAt
        ? Math.max(0, delivery.nextRetryAt.getTime() - Date.now())
        : 0;
      this.scheduleDelivery(delivery.id, delivery.webhookId, delay);
    }

    if (pending.length > 0) {
      this.logger.log(`Re-enqueued ${pending.length} pending delivery(-ies) on startup`);
    }
  }

  /**
   * Enqueue a new webhook event for all active, subscribing endpoints
   * belonging to the organisations the user is a member of.
   *
   * Called by ProofsService after each lifecycle event.
   */
  async enqueueForUser(
    userId: string,
    eventType: WebhookEventType,
    envelope: Omit<WebhookEnvelope, "id" | "specVersion" | "createdAt">,
  ): Promise<void> {
    // Resolve which organisations the user belongs to
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        organizations: {
          select: { id: true },
        },
      },
    });
    if (!user || user.organizations.length === 0) return;

    const orgIds = user.organizations.map((o) => o.id);
    await this.enqueueForOrganizations(orgIds, eventType, envelope);
  }

  /**
   * Enqueue an event for every active, subscribing endpoint of a single
   * organisation.
   *
   * Used by producers whose event belongs to an organisation directly rather
   * than to a user — the attestation reconciler, whose attestations are owned by
   * an issuer's organisation, not by any one user.
   */
  async enqueueForOrganization(
    organizationId: string,
    eventType: WebhookEventType,
    envelope: Omit<WebhookEnvelope, "id" | "specVersion" | "createdAt">,
  ): Promise<void> {
    await this.enqueueForOrganizations([organizationId], eventType, envelope);
  }

  private async enqueueForOrganizations(
    orgIds: string[],
    eventType: WebhookEventType,
    envelope: Omit<WebhookEnvelope, "id" | "specVersion" | "createdAt">,
  ): Promise<void> {
    if (orgIds.length === 0) return;

    const webhooks = await this.prisma.webhook.findMany({
      where: {
        organizationId: { in: orgIds },
        status: "ACTIVE",
      },
      select: {
        id: true,
        url: true,
        secretEncrypted: true,
        events: true,
      },
    });

    for (const hook of webhooks) {
      const subscribedEvents = this.parseEvents(hook.events);
      if (!subscribedEvents.includes(eventType)) continue;

      const eventId = randomUUID();
      const fullEnvelope: WebhookEnvelope = {
        specVersion: "1",
        id: eventId,
        event: eventType,
        createdAt: new Date().toISOString(),
        data: envelope.data,
      };

      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          eventType,
          eventId,
          payload: fullEnvelope as unknown as Prisma.InputJsonValue,
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
        },
        select: { id: true },
      });

      // Initialize circuit breaker for webhook if needed
      await this.circuitBreaker.initializeCircuit(hook.id);

      this.scheduleDelivery(delivery.id, hook.id, 0, fullEnvelope);
    }
  }

  /**
   * Re-deliver a delivery that already has a persisted `WebhookDelivery` row.
   * Called by the replay endpoint.
   *
   * Returns the new delivery id created for the replay attempt.
   */
  async replay(
    originalDeliveryId: string,
    replayedBy: string,
  ): Promise<string> {
    const original = await this.prisma.webhookDelivery.findUnique({
      where: { id: originalDeliveryId },
      include: {
        webhook: {
          select: {
            id: true,
            url: true,
            secretEncrypted: true,
            status: true,
            events: true,
          },
        },
      },
    });

    if (!original) {
      throw new NotFoundException("WebhookDelivery not found");
    }

    if (original.webhook.status !== "ACTIVE") {
      throw new BadRequestException(
        "Cannot replay delivery for a disabled webhook endpoint",
      );
    }

    const replayKey = `${originalDeliveryId}:${replayedBy}`;
    const existingReplay = await this.prisma.webhookDelivery.findUnique({
      where: { replayKey },
      select: { id: true },
    });
    if (existingReplay) return existingReplay.id;

    // Replay is idempotent per (originalDeliveryId, replayedBy): re-using
    // the same eventId in the envelope means integrators can deduplicate on
    // X-EarnProof-Delivery just like they do for normal retries.
    const replayDelivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: original.webhookId,
        eventType: original.eventType,
        payload: original.payload as Prisma.InputJsonValue,
        eventId: original.eventId, // same eventId → integrator deduplicates
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: originalDeliveryId,
        replayedBy,
        replayKey,
      },
      select: { id: true },
    });

    this.scheduleDelivery(replayDelivery.id, original.webhookId, 0);

    return replayDelivery.id;
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling helpers
  // ---------------------------------------------------------------------------

  /**
   * Schedule a delivery to run after `delayMs` milliseconds, serialised
   * behind any already-running delivery for the same webhook.
   *
   * `envelope`, `url`, and `secretEncrypted` are optional: if omitted the
   * worker will re-fetch from the database.  They are passed on the first
   * attempt (from `enqueueForUser`) to avoid an extra round-trip.
   */
  private scheduleDelivery(
    deliveryId: string,
    webhookId: string,
    delayMs: number,
    envelope?: WebhookEnvelope,
  ): void {
    const existing = this.chains.get(webhookId);
    const tail = existing?.tail ?? Promise.resolve();

    const next = tail.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              // Check circuit breaker before attempting delivery
              const canAttempt = await this.circuitBreaker.canAttemptDelivery(webhookId);
              if (!canAttempt) {
                this.logger.debug(`Delivery ${deliveryId} skipped - circuit is OPEN`);
                resolve();
                return;
              }

              await this.runDelivery(
                deliveryId,
                envelope,
                undefined,
                undefined,
                true,
              );
            } catch {
              // runDelivery swallows its own errors and logs them;
              // we must not let an uncaught rejection break the chain.
            }
            resolve();
          }, delayMs);
        }),
    );

    this.chains.set(webhookId, { tail: next });
  }

  /**
   * Execute one delivery attempt.  On failure, either schedules a retry
   * (if attempts remain) or marks the delivery FAILED permanently.
   */
  private async runDelivery(
    deliveryId: string,
    cachedEnvelope?: WebhookEnvelope,
    _cachedUrl?: string,
    _cachedSecretEncrypted?: string,
    holdAggregateQueue = false,
  ): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: {
          select: {
            id: true,
            url: true,
            secretEncrypted: true,
            status: true,
          },
        },
      },
    });

    if (!delivery) {
      this.logger.warn(`Delivery ${deliveryId} not found; skipping`);
      return;
    }

    // If the endpoint was disabled between scheduling and execution, bail.
    if (delivery.webhook.status !== "ACTIVE") {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          failureReason: "webhook endpoint disabled before delivery",
        },
      });
      return;
    }

    const url = delivery.webhook.url;
    const secretEncrypted = delivery.webhook.secretEncrypted;

    // Decrypt signing secret — never stored in plain text or in delivery logs.
    let signingSecret: string;
    try {
      signingSecret = this.paymentEncryptionKeyring.decrypt(secretEncrypted);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt signing secret for webhook ${delivery.webhook.id}: ${String(err)}`,
      );
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          failureReason: "signing secret decryption failure",
        },
      });
      return;
    }

    // The full public payload is persisted, so retries and crash recovery
    // deliver exactly the same signed event rather than an empty envelope.
    const envelope = (cachedEnvelope ?? delivery.payload) as WebhookEnvelope;

    const outcome = await this.sendSignedRequest(
      url,
      signingSecret,
      delivery.eventId,
      delivery.eventType,
      envelope,
    );
    const { statusCode, responseBody, durationMs, success } = outcome;
    let failureReason = outcome.failureReason;

    if (outcome.kind === "blocked") {
      failureReason = outcome.error.message;
      // SSRF block is permanent — do not retry.
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          durationMs,
          failureReason,
          deliveredAt: new Date(),
        },
      });

      durationMs = Date.now() - start;
      statusCode = response.status;

      // Truncate response body to prevent large payloads in logs.
      const rawText = redactSensitiveResponse(await response.text());
      responseBody = rawText.length > MAX_RESPONSE_BODY_BYTES
        ? rawText.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]"
        : rawText;

      success = response.ok;
      if (!success) {
        failureReason = `HTTP ${response.status}`;
      }
    } catch (err) {
      durationMs = Date.now() - start;
      if (err instanceof SsrfBlockedError) {
        failureReason = err.message;
        // SSRF block is permanent — do not retry.
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.FAILED,
            durationMs,
            failureReason,
            deliveredAt: new Date(),
          },
        });

        // Don't record SSRF blocks in circuit breaker (permanent policy failure)
        this.logger.warn(`Delivery ${deliveryId} blocked by SSRF guard: ${failureReason}`);
        return;
      }
      failureReason =
        err instanceof Error && err.name === "TimeoutError"
          ? "delivery request timed out"
          : "delivery request failed";
    }

    if (success) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.SUCCESS,
          statusCode,
          // Redact secrets: responseBody is from the integrator, safe to store.
          responseBody,
          durationMs,
          deliveredAt: new Date(),
        },
      });

      // Record success in circuit breaker
      await this.circuitBreaker.recordSuccess(delivery.webhookId);

      this.logger.log(
        `Delivery ${deliveryId} succeeded (attempt ${delivery.attempt}, ${durationMs}ms, HTTP ${statusCode})`,
      );
      return;
    }

    // Failed attempt — decide whether to retry.
    if (delivery.attempt >= MAX_ATTEMPTS) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          statusCode,
          responseBody,
          durationMs,
          failureReason,
          deliveredAt: new Date(),
        },
      });

      // Record failure in circuit breaker (not permanent for normal failures)
      await this.circuitBreaker.recordFailure(delivery.webhookId, false);

      this.logger.warn(
        `Delivery ${deliveryId} permanently failed after ${delivery.attempt} attempt(s): ${failureReason}`,
      );
      return;
    }

    // Create a new delivery row for the retry (preserves the original row's
    // first-attempt record and makes each attempt queryable individually).
    const nextAttempt = delivery.attempt + 1;
    const delay = backoffMs(nextAttempt);
    const nextRetryAt = new Date(Date.now() + delay);

    // Update current row to reflect it failed but a retry is scheduled.
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        statusCode,
        responseBody,
        durationMs,
        failureReason,
        deliveredAt: new Date(),
      },
    });

    const retryDelivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        payload: delivery.payload as Prisma.InputJsonValue,
        eventId: delivery.eventId, // same eventId across all retries
        attempt: nextAttempt,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: delivery.replayOf, // carry through if this is a replay
        nextRetryAt,
      },
      select: { id: true },
    });

    this.logger.log(
      `Delivery ${deliveryId} failed (attempt ${delivery.attempt}); retrying as ${retryDelivery.id} in ${delay}ms`,
    );

    // Record failure in circuit breaker for retryable failures
    await this.circuitBreaker.recordFailure(delivery.webhookId, false);

    if (holdAggregateQueue) {
      // Keep the production queue occupied through the retry so later events
      // cannot silently overtake an earlier event for the same aggregate.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      await this.runDelivery(
        retryDelivery.id,
        envelope,
        undefined,
        undefined,
        true,
      );
    } else {
      this.scheduleDelivery(retryDelivery.id, delivery.webhookId, delay, envelope);
    }
  }

  // ---------------------------------------------------------------------------
  // Synthetic test delivery
  // ---------------------------------------------------------------------------

  /**
   * Send one synthetic, signed `webhook.test` event to an endpoint and report
   * what happened.
   *
   * Uses exactly the same signing, destination guard, redirect policy, timeout,
   * and response redaction/size limits as a real delivery
   * ({@link sendSignedRequest}), so a passing test means a real event would
   * reach the receiver the same way.
   *
   * It is deliberately NOT a delivery: no `WebhookDelivery` row is written, the
   * per-endpoint FIFO chain is not touched, and a failure is never retried. A
   * synthetic event must never be picked up by startup recovery or the retry
   * path, and must never sit in a business queue ahead of a real event.
   *
   * The caller is responsible for authorization and ownership.
   */
  async sendTestDelivery(webhook: {
    id: string;
    url: string;
    secretEncrypted: string;
  }): Promise<WebhookTestDeliveryResult> {
    const eventId = `${WEBHOOK_TEST_EVENT_ID_PREFIX}${randomUUID()}`;
    const envelope: WebhookTestEnvelope = {
      specVersion: "1",
      id: eventId,
      event: WEBHOOK_TEST_EVENT_TYPE,
      synthetic: true,
      createdAt: new Date().toISOString(),
      data: {
        synthetic: true,
        testEventVersion: WEBHOOK_TEST_EVENT_VERSION,
        webhookId: webhook.id,
        message:
          "Synthetic EarnProof test event. Not a business event; acknowledge and ignore.",
      },
    };

    const base = {
      webhookId: webhook.id,
      eventId,
      eventType: WEBHOOK_TEST_EVENT_TYPE,
      synthetic: true as const,
      testEventVersion: WEBHOOK_TEST_EVENT_VERSION,
      sentAt: envelope.createdAt,
    };

    let signingSecret: string;
    try {
      signingSecret = this.paymentEncryptionKeyring.decrypt(webhook.secretEncrypted);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt signing secret for webhook ${webhook.id}: ${String(err)}`,
      );
      return {
        ...base,
        delivered: false,
        statusClass: "signing_error",
        statusCode: null,
        durationMs: 0,
        failureReason: "signing secret decryption failure",
        response: { body: null, truncated: false, maxBytes: MAX_RESPONSE_BODY_BYTES },
      };
    }

    const outcome = await this.sendSignedRequest(
      webhook.url,
      signingSecret,
      eventId,
      WEBHOOK_TEST_EVENT_TYPE,
      envelope,
    );

    return {
      ...base,
      delivered: outcome.success,
      statusClass: statusClassOf(outcome),
      statusCode: outcome.statusCode ?? null,
      durationMs: outcome.durationMs,
      // The SSRF guard's own message can name the resolved internal address;
      // echoing it to the caller would turn this endpoint into a network probe.
      failureReason:
        outcome.kind === "blocked"
          ? "destination rejected by outbound destination policy"
          : (outcome.failureReason ?? null),
      response: {
        body: outcome.responseBody ?? null,
        truncated: outcome.responseTruncated,
        maxBytes: MAX_RESPONSE_BODY_BYTES,
      },
    };
  }

  /**
   * The production send path: sign, check the destination, POST without
   * following redirects under the delivery timeout, and bound + redact the
   * response body. Never throws; never writes to the database.
   */
  private async sendSignedRequest(
    url: string,
    signingSecret: string,
    eventId: string,
    eventType: string,
    envelope: WebhookEnvelope | WebhookTestEnvelope,
  ): Promise<SignedRequestOutcome> {
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = this.signing.sign(signingSecret, timestamp, eventId, body);

    const start = Date.now();
    try {
      await assertSafeWebhookDestination(url);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-EarnProof-Timestamp": String(timestamp),
          "X-EarnProof-Delivery": eventId,
          "X-EarnProof-Event": eventType,
          "X-EarnProof-Signature": signature,
        },
        body,
        // Do NOT follow redirects — prevents an open redirect from
        // forwarding a signed payload to an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      const durationMs = Date.now() - start;

      // Truncate response body to prevent large payloads in logs.
      const bounded = boundResponseBody(await response.text());

      return {
        kind: "response",
        success: response.ok,
        statusCode: response.status,
        responseBody: bounded.body,
        responseTruncated: bounded.truncated,
        durationMs,
        failureReason: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      if (err instanceof SsrfBlockedError) {
        return {
          kind: "blocked",
          error: err,
          success: false,
          responseTruncated: false,
          durationMs,
        };
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        return {
          kind: "timeout",
          success: false,
          responseTruncated: false,
          durationMs,
          failureReason: "delivery request timed out",
        };
      }
      return {
        kind: isRedirectError(err) ? "redirect" : "network_error",
        success: false,
        responseTruncated: false,
        durationMs,
        failureReason: "delivery request failed",
      };
    }
  }

  private parseEvents(events: unknown): WebhookEventType[] {
    if (Array.isArray(events)) {
      return events.filter((e): e is WebhookEventType => typeof e === "string");
    }
    return [];
  }
}

/**
 * Result of one pass through the production send path.
 *
 * `kind` separates outcomes a caller may want to distinguish (the stored
 * `failureReason` strings for real deliveries are unchanged by it).
 */
type SignedRequestOutcome =
  | {
      kind: "response";
      success: boolean;
      statusCode: number;
      responseBody: string;
      responseTruncated: boolean;
      durationMs: number;
      failureReason?: string;
    }
  | {
      kind: "blocked";
      error: SsrfBlockedError;
      success: false;
      statusCode?: undefined;
      responseBody?: undefined;
      responseTruncated: false;
      durationMs: number;
      failureReason?: undefined;
    }
  | {
      kind: "timeout" | "redirect" | "network_error";
      success: false;
      statusCode?: undefined;
      responseBody?: undefined;
      responseTruncated: false;
      durationMs: number;
      failureReason: string;
    };

/**
 * Coarse outcome of a test delivery.
 *
 * - `2xx`…`5xx`: the receiver answered with that status class.
 * - `timeout`: no answer within the delivery timeout.
 * - `redirect_rejected`: the receiver answered with a redirect, which is never
 *   followed for a signed payload.
 * - `destination_rejected`: the outbound destination policy refused the URL.
 * - `network_error`: connection, TLS, or DNS failure.
 * - `signing_error`: the endpoint's signing secret could not be decrypted.
 */
export const WEBHOOK_TEST_STATUS_CLASSES = [
  "1xx",
  "2xx",
  "3xx",
  "4xx",
  "5xx",
  "timeout",
  "redirect_rejected",
  "destination_rejected",
  "network_error",
  "signing_error",
] as const;

export type WebhookTestStatusClass = (typeof WEBHOOK_TEST_STATUS_CLASSES)[number];

/** Diagnostic result of a synthetic test delivery. Contains no secrets. */
export interface WebhookTestDeliveryResult {
  webhookId: string;
  eventId: string;
  eventType: typeof WEBHOOK_TEST_EVENT_TYPE;
  synthetic: true;
  testEventVersion: typeof WEBHOOK_TEST_EVENT_VERSION;
  sentAt: string;
  delivered: boolean;
  statusClass: WebhookTestStatusClass;
  statusCode: number | null;
  durationMs: number;
  failureReason: string | null;
  response: {
    /** Redacted receiver body, bounded to `maxBytes` (plus a truncation marker). */
    body: string | null;
    truncated: boolean;
    maxBytes: number;
  };
}

function statusClassOf(outcome: SignedRequestOutcome): WebhookTestStatusClass {
  switch (outcome.kind) {
    case "response":
      return `${Math.min(5, Math.max(1, Math.floor(outcome.statusCode / 100)))}xx` as WebhookTestStatusClass;
    case "blocked":
      return "destination_rejected";
    case "timeout":
      return "timeout";
    case "redirect":
      return "redirect_rejected";
    default:
      return "network_error";
  }
}

/**
 * With `redirect: "error"`, fetch (undici) rejects a 3xx answer with a
 * `TypeError` whose cause mentions the redirect.
 */
function isRedirectError(err: unknown): boolean {
  // Duck-typed rather than `instanceof Error`: fetch's errors can come from a
  // different realm than this module's `Error`.
  const messageOf = (value: unknown): string =>
    typeof value === "object" && value !== null && "message" in value
      ? String((value as { message: unknown }).message)
      : "";
  const cause = (err as { cause?: unknown } | null)?.cause;
  return /redirect/i.test(`${messageOf(err)} ${messageOf(cause)}`);
}

/**
 * Redact and bound a receiver response body — the single place the stored
 * `responseBody` of a real delivery and the diagnostics of a test delivery are
 * produced, so both obey the same limits.
 */
export function boundResponseBody(raw: string): { body: string; truncated: boolean } {
  const redacted = redactSensitiveResponse(raw);
  if (redacted.length > MAX_RESPONSE_BODY_BYTES) {
    return {
      body: redacted.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]",
      truncated: true,
    };
  }
  return { body: redacted, truncated: false };
}

function redactSensitiveResponse(value: string): string {
  return value
    .replace(
      /(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
