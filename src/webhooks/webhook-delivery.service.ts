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
import { WebhookEventSource, WebhookEventType } from "./webhook-event.types";
import {
  payloadDeprecation,
  serializeWebhookEvent,
} from "./webhook-payload.serializers";
import { WebhookSigningService } from "./webhook-signing.service";
import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
} from "./webhook-ssrf-guard";

/** Maximum stored response body size in bytes (1 KiB). */
const MAX_RESPONSE_BODY_BYTES = 1024;

/** Delivery timeout in milliseconds. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Default maximum delivery attempts per chain (1 initial + 4 retries).
 * Overridable with WEBHOOK_MAX_DELIVERY_ATTEMPTS.
 */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

/** Exponential backoff base in milliseconds. */
const BACKOFF_BASE_MS = 1_000;

/**
 * Stable reason codes recorded when a delivery chain ends without success.
 * Codes, not messages: operators filter on them, and they never carry
 * response content.
 */
export const DeadLetterReason = {
  MAX_ATTEMPTS_EXHAUSTED: "max_attempts_exhausted",
  DESTINATION_BLOCKED: "destination_blocked",
  SIGNING_SECRET_UNAVAILABLE: "signing_secret_unavailable",
  ENDPOINT_DISABLED: "endpoint_disabled",
} as const;

export type DeadLetterReasonValue =
  (typeof DeadLetterReason)[keyof typeof DeadLetterReason];

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
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly encryptionKey: string;
  private readonly maxAttempts: number;
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
    configService: ConfigService,
  ) {
    this.encryptionKey = configService.getOrThrow<string>("paymentEncryptionKey");
    this.maxAttempts =
      configService.get<number>("webhooks.maxDeliveryAttempts") ??
      DEFAULT_MAX_DELIVERY_ATTEMPTS;
  }

  /** The configured retry threshold: attempts allowed per delivery chain. */
  get maxDeliveryAttempts(): number {
    return this.maxAttempts;
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
   * Enqueue a domain event for all active, subscribing endpoints belonging to
   * the organisations the user is a member of.
   *
   * The event gets one identifier and one occurrence time, shared by every
   * endpoint and every later retry. Each endpoint receives the payload version
   * it is pinned to, serialized once and persisted as exact bytes.
   *
   * Called by ProofsService after each lifecycle event.
   */
  async enqueueForUser(
    userId: string,
    domainEvent: WebhookEventSource,
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
    const webhooks = await this.prisma.webhook.findMany({
      where: {
        organizationId: { in: orgIds },
        status: "ACTIVE",
      },
      select: {
        id: true,
        events: true,
        payloadVersion: true,
      },
    });

    const eventId = randomUUID();
    const occurredAt = new Date();

    for (const hook of webhooks) {
      const subscribedEvents = this.parseEvents(hook.events);
      if (!subscribedEvents.includes(domainEvent.event)) continue;

      let serialized: ReturnType<typeof serializeWebhookEvent>;
      try {
        serialized = serializeWebhookEvent({
          event: domainEvent.event,
          source: domainEvent.source as never,
          eventId,
          occurredAt,
          version: hook.payloadVersion,
        });
      } catch (err) {
        // Fail closed: an event that cannot be serialized to the endpoint's
        // declared contract is not delivered at all.
        this.logger.error(
          `Webhook ${hook.id}: cannot serialize ${domainEvent.event} for payload version ${hook.payloadVersion}: ${String(err)}`,
        );
        continue;
      }

      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          eventType: domainEvent.event,
          eventId,
          payload: serialized.envelope as unknown as Prisma.InputJsonValue,
          schemaVersion: serialized.schemaVersion,
          payloadBody: serialized.body,
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
        },
        select: { id: true },
      });

      this.scheduleDelivery(delivery.id, hook.id, 0);
    }
  }

  /**
   * Schedule an already-persisted PENDING delivery for immediate dispatch,
   * serialised behind any in-flight delivery for the same endpoint.
   *
   * Used by redrive, which creates its delivery row inside a transaction and
   * must dispatch only after that transaction has committed.
   */
  dispatch(deliveryId: string, webhookId: string): void {
    this.scheduleDelivery(deliveryId, webhookId, 0);
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
        // Original version and bytes: a replay is the same event, not a new one.
        schemaVersion: original.schemaVersion,
        payloadBody: original.payloadBody,
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
   * The worker always re-reads the delivery row: the persisted body is the
   * single source of truth for what is signed and sent.
   */
  private scheduleDelivery(
    deliveryId: string,
    webhookId: string,
    delayMs: number,
  ): void {
    const existing = this.chains.get(webhookId);
    const tail = existing?.tail ?? Promise.resolve();

    const next = tail.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              await this.runDelivery(deliveryId, true);
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
   * Execute one delivery attempt. On failure, either schedules a retry (while
   * the retry threshold has not been reached) or dead-letters the attempt.
   */
  private async runDelivery(
    deliveryId: string,
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

    // A delivery row is attempted at most once. Crash recovery and redrive can
    // both schedule the same row; only a PENDING row is ever dispatched.
    if (delivery.status !== WebhookDeliveryStatus.PENDING) {
      this.logger.warn(
        `Delivery ${deliveryId} is ${delivery.status}, not PENDING; skipping`,
      );
      return;
    }

    // If the endpoint was disabled or deleted between scheduling and
    // execution, stop the chain without sending.
    if (delivery.webhook.status !== "ACTIVE") {
      await this.deadLetter(deliveryId, DeadLetterReason.ENDPOINT_DISABLED, {
        failureReason: "webhook endpoint disabled before delivery",
      });
      return;
    }

    // Respect the configured threshold even for rows created under a higher
    // one (e.g. after WEBHOOK_MAX_DELIVERY_ATTEMPTS was lowered).
    if (delivery.attempt > this.maxAttempts) {
      await this.deadLetter(
        deliveryId,
        DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED,
        { failureReason: "retry threshold reached before dispatch" },
      );
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
      await this.deadLetter(
        deliveryId,
        DeadLetterReason.SIGNING_SECRET_UNAVAILABLE,
        { failureReason: "signing secret decryption failure" },
      );
      return;
    }

    // The persisted bytes are exactly what was serialized when the event
    // occurred. Every attempt signs and sends these bytes, never a
    // re-serialization of `payload`.
    const body = delivery.payloadBody;
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = this.signing.sign(signingSecret, timestamp, delivery.eventId, body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-EarnProof-Timestamp": String(timestamp),
      "X-EarnProof-Delivery": delivery.eventId,
      "X-EarnProof-Event": delivery.eventType,
      "X-EarnProof-Schema-Version": delivery.schemaVersion,
      "X-EarnProof-Signature": signature,
    };
    // Deprecation is announced in delivery metadata, never in the body: the
    // body is the contract under discussion (docs/versioning.md).
    const deprecation = payloadDeprecation(
      delivery.eventType,
      delivery.schemaVersion,
    );
    if (deprecation) {
      headers["Deprecation"] = "true";
      headers["Sunset"] = new Date(deprecation.sunsetAt).toUTCString();
    }

    let statusCode: number | undefined;
    let responseBody: string | undefined;
    let durationMs: number | undefined;
    let success = false;
    let failureReason: string | undefined;

    const start = Date.now();
    try {
      await assertSafeWebhookDestination(url);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        // Do NOT follow redirects — prevents an open redirect from
        // forwarding a signed payload to an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
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
        await this.deadLetter(deliveryId, DeadLetterReason.DESTINATION_BLOCKED, {
          durationMs,
          failureReason,
          deliveredAt: new Date(),
        });
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
      this.logger.log(
        `Delivery ${deliveryId} succeeded (attempt ${delivery.attempt}, ${durationMs}ms, HTTP ${statusCode})`,
      );
      return;
    }

    // Failed attempt — the retry threshold decides whether the chain ends.
    if (delivery.attempt >= this.maxAttempts) {
      await this.deadLetter(deliveryId, DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED, {
        statusCode,
        responseBody,
        durationMs,
        failureReason,
        deliveredAt: new Date(),
      });
      this.logger.warn(
        `Delivery ${deliveryId} dead-lettered after ${delivery.attempt} attempt(s): ${failureReason}`,
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
        schemaVersion: delivery.schemaVersion, // original version
        payloadBody: delivery.payloadBody, // original bytes
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

    if (holdAggregateQueue) {
      // Keep the production queue occupied through the retry so later events
      // cannot silently overtake an earlier event for the same aggregate.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      await this.runDelivery(retryDelivery.id, true);
    } else {
      this.scheduleDelivery(retryDelivery.id, delivery.webhookId, delay);
    }
  }

  /**
   * Terminal failure: the chain stops here and the attempt is marked
   * dead-lettered so an operator can inspect and, if appropriate, redrive it.
   */
  private async deadLetter(
    deliveryId: string,
    reason: DeadLetterReasonValue,
    attempt: {
      statusCode?: number;
      responseBody?: string;
      durationMs?: number;
      failureReason: string | undefined;
      deliveredAt?: Date;
    },
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        ...attempt,
        deadLetteredAt: new Date(),
        deadLetterReason: reason,
      },
    });
  }

  private parseEvents(events: unknown): WebhookEventType[] {
    if (Array.isArray(events)) {
      return events.filter((e): e is WebhookEventType => typeof e === "string");
    }
    return [];
  }
}

function redactSensitiveResponse(value: string): string {
  return value
    .replace(
      /(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
