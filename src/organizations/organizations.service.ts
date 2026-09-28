import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { ListOrganizationsDto } from "./dto/list-organizations.dto";
import { OrganizationResponseDto } from "./dto/organization-response.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotas: OrganizationQuotaService,
  ) {}

  async createOrganization(
    user: AuthenticatedUser,
    input: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can create organizations");
    }

    // Check if slug already exists
    const existing = await this.prisma.organization.findUnique({
      where: { slug: input.slug },
    });

    if (existing) {
      throw new ConflictException(
        `Organization with slug "${input.slug}" already exists`,
      );
    }

    const org = await this.prisma.organization.create({
      data: {
        name: input.name,
        slug: input.slug,
        website: input.website || null,
        createdById: user.id,
        status: ResourceStatus.PENDING,
      },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "Organization", org.id, {
      name: org.name,
      slug: org.slug,
      website: org.website,
    });

    return this.toResponseDto(org);
  }

  async updateOrganization(
    user: AuthenticatedUser,
    organizationId: string,
    input: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const org = await this.getOrganizationById(organizationId);

    // Check ownership: only creator or admin can update
    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to update this organization",
      );
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.website !== undefined && { website: input.website || null }),
      },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE", "Organization", organizationId, {
      changes: input,
    });

    return this.toResponseDto(updated);
  }

  async getOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationResponseDto> {
    const org = await this.getOrganizationById(organizationId);
    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to access this organization",
      );
    }
    const issuerCount = await this.prisma.issuer.count({
      where: { organizationId },
    });

    return {
      ...this.toResponseDto(org),
      issuerCount,
    };
  }

  /**
   * Current quota usage and reset context. Same access rule as
   * {@link getOrganization}: the creator or an ADMIN. Counts and limits only —
   * no resource identifiers.
   */
  async getUsage(user: AuthenticatedUser, organizationId: string) {
    const org = await this.getOrganizationById(organizationId);
    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to access this organization",
      );
    }
    return this.quotas.getUsage(organizationId);
  }

  async listOrganizations(
    user: AuthenticatedUser,
    query: ListOrganizationsDto,
  ): Promise<{
    items: OrganizationResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) {
      where.status = query.status;
    }

    // Non-admins only see organizations they created
    if (user.role !== "ADMIN") {
      where.createdById = user.id;
    }

    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.organization.count({ where }),
    ]);

    const response = await Promise.all(
      items.map(async (org) => {
        const issuerCount = await this.prisma.issuer.count({
          where: { organizationId: org.id },
        });
        return {
          ...this.toResponseDto(org),
          issuerCount,
        };
      }),
    );

    return {
      items: response,
      total,
      page,
      limit,
    };
  }

  async getOrganizationById(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new NotFoundException(
        `Organization with ID "${organizationId}" not found`,
      );
    }

    return org;
  }

  private toResponseDto(org: any): OrganizationResponseDto {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      website: org.website,
      status: org.status,
      createdById: org.createdById,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    };
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: any,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        metadata,
        createdAt: new Date(),
      },
    });
  }
}
