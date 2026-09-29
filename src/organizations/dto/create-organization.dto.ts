import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsUrl,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

export class CreateOrganizationDto {
  @ApiProperty({
    description: "Organization display name",
    example: "Acme Corporation",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(FIELD_LIMITS.name)
  name: string;

  @ApiProperty({
    description: "Organization URL slug (lowercase, alphanumeric, hyphens)",
    example: "acme-corp",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.name)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be lowercase alphanumeric with hyphens only",
  })
  slug: string;

  @ApiPropertyOptional({
    description: "Organization website URL",
    example: "https://acme.example.com",
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(FIELD_LIMITS.url)
  website?: string;
}
