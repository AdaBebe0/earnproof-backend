import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsObject, IsOptional, MaxLength } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { MaxBytes, MaxDepth } from "../../common/validation/payload-limits";

export class CreateIssuerDto {
  @ApiProperty({
    description: "Organization ID this issuer belongs to",
    example: "cuid123",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.id)
  organizationId: string;

  @ApiProperty({
    description: "Stellar public key address for this issuer",
    example: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.stellarAddress)
  stellarAddress: string;

  @ApiPropertyOptional({
    description: "Public metadata about the issuer (name, description, etc.)",
    example: {
      name: "Acme Payment Services",
      description: "A trusted payment issuer",
      logoUrl: "https://example.com/logo.png",
    },
  })
  @IsOptional()
  @IsObject()
  @MaxBytes(FIELD_LIMITS.metadataBytes)
  @MaxDepth(FIELD_LIMITS.metadataDepth)
  publicMetadata?: Record<string, any>;
}
