import { ApiProperty } from "@nestjs/swagger";

export class ChallengeResponseDto {
  @ApiProperty({
    description: "Unique identifier for this challenge. Pass it back in the verify request.",
    example: "clx1abc2def3ghi4",
  })
  id!: string;

  @ApiProperty({
    description:
      "The plain-text message the wallet must sign. It embeds the domain, network, wallet address, nonce, and expiry.",
    example:
      "EarnProof wallet authentication\nDomain: https://app.earnproof.io\nNetwork: Test SDF Network ; September 2015\nWallet: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF\nNonce: abc123\nExpires At: 2025-01-01T12:05:00.000Z",
  })
  message!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp after which this challenge can no longer be verified.",
    example: "2025-01-01T12:05:00.000Z",
  })
  expiresAt!: string;
}
