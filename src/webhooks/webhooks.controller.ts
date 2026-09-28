import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { PrismaService } from "../database/prisma.service";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import {
  ListDeadLettersQueryDto,
  RedriveDeadLetterDto,
  RedriveDeadLettersBatchDto,
} from "./dto/dead-letter.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";
import { WebhooksService } from "./webhooks.service";

/**
 * Resolves the organisation ID from the current authenticated user.
 *
 * The JWT carries userId only.  We query the first ACTIVE organisation
 * the user belongs to.  In a multi-org scenario the org could be passed
 * as a path or query param — kept simple here per scope constraints.
 */
@ApiTags("webhooks")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly deadLetters: WebhookDeadLetterService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Dead letters (operator: DEVELOPER or ADMIN, own organisation only)
  //
  // Declared before the `:id` routes so `dead-letters` is never captured as a
  // webhook id.
  // ---------------------------------------------------------------------------

  @Get("dead-letters")
  @ApiOperation({
    summary: "List dead-lettered deliveries for your organisation (DEVELOPER or ADMIN)",
  })
  async listDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDeadLettersQueryDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.list(orgId, query);
  }

  @Post("dead-letters/redrive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Redrive a bounded batch of dead-lettered deliveries (DEVELOPER or ADMIN)",
    description:
      "Each item is redriven independently and reported with a stable outcome code. " +
      "An operator reason is required and audited.",
  })
  async redriveDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RedriveDeadLettersBatchDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.redriveBatch(
      orgId,
      body.deliveryIds,
      user.id,
      body.reason,
    );
  }

  @Get("dead-letters/:deliveryId")
  @ApiOperation({
    summary: "Inspect a dead-lettered delivery and its attempt history (DEVELOPER or ADMIN)",
  })
  async getDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.get(orgId, deliveryId);
  }

  @Post("dead-letters/:deliveryId/redrive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Redrive one dead-lettered delivery (DEVELOPER or ADMIN)",
    description:
      "Creates a new delivery carrying the original event id and payload bytes. " +
      "Idempotent: a second redrive of the same dead letter returns the first one.",
  })
  async redriveDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
    @Body() body: RedriveDeadLetterDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    const result = await this.deadLetters.redrive(
      orgId,
      deliveryId,
      user.id,
      body.reason,
    );
    if (result.outcome === "not_found") {
      throw new NotFoundException("Dead-lettered delivery not found");
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Endpoint management
  // ---------------------------------------------------------------------------

  @Post()
  @ApiOperation({ summary: "Create a webhook endpoint" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebhookDto) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List webhook endpoints for your organisation" })
  async list(@CurrentUser() user: AuthenticatedUser) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listForOrg(orgId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a webhook endpoint" })
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.getForOrg(orgId, id);
  }

  @Patch(":id/events")
  @ApiOperation({ summary: "Update event subscriptions" })
  async updateEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateWebhookEventsDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.updateEvents(orgId, id, dto);
  }

  @Post(":id/rotate-secret")
  @ApiOperation({ summary: "Rotate the signing secret (returns new secret once)" })
  async rotateSecret(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.rotateSecret(orgId, id);
  }

  @Patch(":id/disable")
  @ApiOperation({ summary: "Disable a webhook endpoint" })
  async disable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.disable(orgId, id);
  }

  @Patch(":id/enable")
  @ApiOperation({ summary: "Re-enable a webhook endpoint" })
  async enable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.enable(orgId, id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a webhook endpoint" })
  async delete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.delete(orgId, id);
  }

  // ---------------------------------------------------------------------------
  // Delivery observability
  // ---------------------------------------------------------------------------

  @Get(":id/deliveries")
  @ApiOperation({ summary: "List delivery records for a webhook endpoint" })
  async listDeliveries(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listDeliveries(orgId, id);
  }

  // ---------------------------------------------------------------------------
  // Manual replay
  // ---------------------------------------------------------------------------

  @Post("deliveries/:deliveryId/replay")
  @ApiOperation({ summary: "Manually replay a delivery (DEVELOPER or ADMIN only)" })
  async replayDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.replayDelivery(orgId, deliveryId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async requireOrgId(user: AuthenticatedUser): Promise<string> {
    // Find an active organization the user belongs to
    const userWithOrgs = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        organizations: {
          where: { status: "ACTIVE" },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!userWithOrgs?.organizations?.[0]) {
      throw new ForbiddenException("No active organisation found for this user");
    }

    return userWithOrgs.organizations[0].id;
  }

  private requirePrivilegedRole(user: AuthenticatedUser): void {
    if (user.role !== "DEVELOPER" && user.role !== "ADMIN") {
      throw new ForbiddenException(
        "Only DEVELOPER or ADMIN users may inspect, replay, or redrive webhook deliveries",
      );
    }
  }
}
