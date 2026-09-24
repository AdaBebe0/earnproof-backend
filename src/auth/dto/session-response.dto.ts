import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SessionUserDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({
    description: "The user's Stellar public key.",
    example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  })
  walletAddress!: string;

  @ApiProperty({
    description: "SHA-256 hash of the wallet address, prefixed with 'sha256:'.",
    example: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  })
  walletHash!: string;

  @ApiProperty({
    example: "WORKER",
    enum: ["WORKER", "ISSUER", "ADMIN", "DEVELOPER"],
  })
  role!: string;

  @ApiProperty({
    example: "ACTIVE",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status!: string;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp of the last successful login.",
    example: "2025-01-01T10:00:00.000Z",
    nullable: true,
  })
  lastLoginAt!: string | null;
}

export class SessionResponseDto {
  @ApiProperty({ type: () => SessionUserDto })
  user!: SessionUserDto;
}
