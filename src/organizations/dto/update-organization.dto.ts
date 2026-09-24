import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsUrl, IsOptional, MinLength } from "class-validator";

export class UpdateOrganizationDto {
  @ApiPropertyOptional({
    description: "Organization display name",
    example: "Acme Corporation",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({
    description: "Organization website URL",
    example: "https://acme.example.com",
  })
  @IsOptional()
  @IsUrl()
  website?: string;
}
