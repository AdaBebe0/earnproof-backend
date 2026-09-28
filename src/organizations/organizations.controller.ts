import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { ListOrganizationsDto } from "./dto/list-organizations.dto";
import { OrganizationResponseDto } from "./dto/organization-response.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";
import { OrganizationsService } from "./organizations.service";

@ApiBearerAuth()
@ApiTags("organizations")
@Controller("organizations")
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Create a new organization",
    description:
      "Admin-only endpoint to create a new organization with pending status",
  })
  @ApiResponse({
    status: 201,
    description: "Organization created successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: "Organization slug already exists",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
  })
  createOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateOrganizationDto,
  ) {
    return this.organizationsService.createOrganization(user, input);
  }

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "List organizations",
    description:
      "List organizations. Admins see all, others see only their own created organizations.",
  })
  @ApiResponse({
    status: 200,
    description: "Organizations retrieved successfully",
  })
  listOrganizations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrganizationsDto,
  ) {
    return this.organizationsService.listOrganizations(user, query);
  }

  @Get(":id")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Get organization details",
    description:
      "Retrieve full details of an organization including issuer count",
  })
  @ApiResponse({
    status: 200,
    description: "Organization retrieved successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  getOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
  ) {
    return this.organizationsService.getOrganization(user, organizationId);
  }

  @Get(":id/usage")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Get organization quota usage",
    description:
      "Current usage, limits, and reset times for the organization's operational quotas " +
      "(active API keys, webhooks, proof requests per day, payment syncs per hour). " +
      "Only the organization creator or an admin may view it.",
  })
  @ApiResponse({ status: 200, description: "Quota usage report" })
  @ApiResponse({ status: 403, description: "Not the creator or an admin" })
  @ApiResponse({ status: 404, description: "Organization not found" })
  getUsage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
  ) {
    return this.organizationsService.getUsage(user, organizationId);
  }

  @Patch(":id")
  @UseGuards(AuthGuard, RoleGuard)
  @ApiOperation({
    summary: "Update organization",
    description:
      "Update organization name and/or website. Only creator or admin can update.",
  })
  @ApiResponse({
    status: 200,
    description: "Organization updated successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - not creator or admin",
  })
  updateOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Body() input: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(
      user,
      organizationId,
      input,
    );
  }
}
