import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSecretVersioningService } from "./webhook-secret-versioning.service";

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: WebhookDeliveryService,
    private readonly secretVersioning: WebhookSecretVersioningService,
    configService: ConfigService,
  ) {}

  /**
   * Create a webhook endpoint for the given organisation.
   *
   * Returns the raw signing secret ONCE — it is never retrievable again.
   * The caller must store it securely.
   */
  async create(organizationId: string, dto: CreateWebhookDto) {
    // De-duplicate events list
    const events = [...new Set(dto.events)];

    // Create the webhook first with a placeholder
    const webhook = await this.prisma.webhook.create({
      data: {
        organizationId,
        url: dto.url,
        secretEncrypted: "", // Will be populated after secret is created
        events,
        status: ResourceStatus.ACTIVE,
      },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
      },
    });

    // Create the initial versioned secret
    const { rawSecret, keyId } = await this.secretVersioning.createInitialSecret(webhook.id);

    return {
      ...webhook,
      // Returned once at creation time only.
      signingSecret: rawSecret,
      keyId,
    };
  }

  /** List all webhook endpoints for an organisation. */
  listForOrg(organizationId: string) {
    return this.prisma.webhook.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /** Get a single webhook, asserting ownership. */
  async getForOrg(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  /**
   * Rotate the webhook signing secret.
   *
   * Moves the current ACTIVE secret to OVERLAP state (with a bounded overlap window)
   * and creates a new ACTIVE secret. This allows retries and replays to use the previous
   * key for a limited time.
   *
   * Returns the new raw secret and keyId once.
   */
  async rotateSecret(organizationId: string, webhookId: string) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    const { rawSecret, keyId } = await this.secretVersioning.rotateSecret(webhookId);

    return {
      webhookId,
      signingSecret: rawSecret,
      keyId,
      rotatedAt: new Date().toISOString(),
      note: "Previous secret is active for the overlap window to allow retries to use it. After the window expires, only new deliveries will use the new secret.",
    };
  }

  /** Update subscribed event types. */
  async updateEvents(
    organizationId: string,
    webhookId: string,
    dto: UpdateWebhookEventsDto,
  ) {
    await this.assertOwnedWebhook(organizationId, webhookId);
    const events = [...new Set(dto.events)];

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: { events },
      select: { id: true, url: true, events: true, status: true, updatedAt: true },
    });
  }

  /** Disable (suspend) a webhook endpoint without deleting it. */
  async disable(organizationId: string, webhookId: string) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: { status: ResourceStatus.SUSPENDED },
      select: { id: true, status: true, updatedAt: true },
    });
  }

  /** Re-enable a previously disabled webhook endpoint. */
  async enable(organizationId: string, webhookId: string) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: { status: ResourceStatus.ACTIVE },
      select: { id: true, status: true, updatedAt: true },
    });
  }

  /** Soft-delete (mark DELETED) a webhook endpoint. */
  async delete(organizationId: string, webhookId: string) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    await this.prisma.webhook.update({
      where: { id: webhookId },
      data: { status: ResourceStatus.DELETED },
    });

    return { deleted: true, webhookId };
  }

  /**
   * Replay a specific delivery.
   *
   * Authorization (DEVELOPER or ADMIN role) is enforced in the controller.
   * The caller must also own the webhook org.
   */
  async replayDelivery(
    organizationId: string,
    deliveryId: string,
    replayedById: string,
  ) {
    // Verify the delivery belongs to one of this org's webhooks.
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: { select: { organizationId: true } },
      },
    });

    if (!delivery) {
      throw new NotFoundException("Delivery not found");
    }

    if (delivery.webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Delivery does not belong to this organisation");
    }

    // Persist audit record before dispatching.
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: replayedById,
        action: "webhook.delivery.replayed",
        resourceType: "webhookDelivery",
        resourceId: deliveryId,
        metadata: {
          webhookId: delivery.webhookId,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          originalAttempt: delivery.attempt,
        },
      },
    });

    const newDeliveryId = await this.deliveryService.replay(deliveryId, replayedById);

    return {
      replayDeliveryId: newDeliveryId,
      originalDeliveryId: deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      replayedBy: replayedById,
      replayedAt: new Date().toISOString(),
    };
  }

  /**
   * List delivery records for a webhook endpoint.
   * Response body and sensitive headers are never stored in delivery rows,
   * so this is safe to return directly.
   */
  async listDeliveries(organizationId: string, webhookId: string) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        eventType: true,
        eventId: true,
        attempt: true,
        status: true,
        statusCode: true,
        // responseBody stored truncated — safe to return
        responseBody: true,
        durationMs: true,
        failureReason: true,
        replayOf: true,
        replayedBy: true,
        deliveredAt: true,
        nextRetryAt: true,
        createdAt: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async assertOwnedWebhook(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, organizationId: true, status: true },
    });
    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  private assertOwnership(
    webhook: { organizationId: string } | null,
    organizationId: string,
    webhookId: string,
  ): void {
    if (!webhook) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }
    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Webhook does not belong to this organisation");
    }
  }
}
