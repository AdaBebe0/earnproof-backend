import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";
import { ResourceStatus } from "@prisma/client";

export class UpdateIssuerStatusDto {
  @ApiProperty({
    description:
      "Target status. Valid transitions: PENDING→ACTIVE, ACTIVE→SUSPENDED, SUSPENDED→ACTIVE, ACTIVE→REVOKED",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsEnum(ResourceStatus)
  status: ResourceStatus;
}
