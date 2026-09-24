import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum, IsNumber, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import { ResourceStatus } from "@prisma/client";

export class ListOrganizationsDto {
  @ApiPropertyOptional({
    description: "Filter by organization status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsOptional()
  @IsEnum(ResourceStatus)
  status?: ResourceStatus;

  @ApiPropertyOptional({
    description: "Page number for pagination (1-indexed)",
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: "Number of items per page",
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
