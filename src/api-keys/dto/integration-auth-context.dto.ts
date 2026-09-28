import { ApiProperty } from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";

/**
 * The safe half of an authenticated API key.
 *
 * An integrator calls `GET /integrations/auth-context` to confirm a key works
 * and to discover what it is allowed to do. Everything here is already known to
 * the caller or non-secret by construction: the prefix is the first 8 characters
 * of a 43-character key, and no field can be used to reconstruct the secret.
 */
export class IntegrationAuthContextDto {
  @ApiProperty({
    description: "Identifier of the API key that authenticated this request.",
    example: "ckv8v6h2b0000qzrmn831i7rn",
  })
  keyId!: string;

  @ApiProperty({
    description:
      "First 8 characters of the key. Non-secret; safe to display in dashboards and logs.",
    example: "sK3xQ9tV",
  })
  prefix!: string;

  @ApiProperty({
    description: "Organization the key belongs to.",
    example: "ckv8v6h2b0001qzrm6ap0hf3d",
  })
  organizationId!: string;

  @ApiProperty({
    description: "Scopes granted to the key, in no particular order.",
    enum: ApiKeyScope,
    isArray: true,
    example: [ApiKeyScope.ORG_READ, ApiKeyScope.PROOF_VERIFY],
  })
  scopes!: ApiKeyScope[];
}
