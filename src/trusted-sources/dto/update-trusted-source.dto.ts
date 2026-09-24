import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateTrustedSourceDto {
  @ApiPropertyOptional({
    description: "Updated human-readable name for the trusted source",
    example: "My Employer Account - Updated",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    description: "Updated issuer ID to link this trusted source to a known issuer",
    example: "issuer_456def",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  issuerId?: string;
}
