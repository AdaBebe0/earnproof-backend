import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

export class CreateTrustedSourceDto {
  @ApiProperty({
    description: "The normalized source address (e.g., Stellar account address)",
    example: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.stellarAddress)
  sourceAddress: string;

  @ApiPropertyOptional({
    description: "Optional human-readable name for the trusted source",
    example: "My Employer Account",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    description: "The type of source (e.g., 'stellar', 'payment_processor')",
    example: "stellar",
  })
  @IsOptional()
  @IsIn(["stellar"])
  sourceType?: string;

  @ApiPropertyOptional({
    description: "Optional issuer ID to link this trusted source to a known issuer",
    example: "issuer_123abc",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.id)
  issuerId?: string;
}
