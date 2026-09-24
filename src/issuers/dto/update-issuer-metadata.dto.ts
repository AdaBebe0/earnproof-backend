import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { MaxBytes, MaxDepth } from "../../common/validation/payload-limits";

export class UpdateIssuerMetadataDto {
  @ApiProperty({
    description:
      "Public metadata about the issuer. Redacted to allowlist when returned to public endpoints.",
    example: {
      name: "Acme Payment Services",
      description: "A trusted payment issuer",
      logoUrl: "https://example.com/logo.png",
      supportEmail: "support@acme.example.com",
    },
  })
  @IsObject()
  @MaxBytes(FIELD_LIMITS.metadataBytes)
  @MaxDepth(FIELD_LIMITS.metadataDepth)
  publicMetadata: Record<string, any>;
}
