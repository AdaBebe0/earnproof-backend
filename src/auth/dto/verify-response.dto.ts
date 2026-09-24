import { ApiProperty } from "@nestjs/swagger";

export class VerifyUserDto {
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
    description: "Role assigned to the user.",
    example: "WORKER",
    enum: ["WORKER", "ISSUER", "ADMIN", "DEVELOPER"],
  })
  role!: string;
}

export class SessionDto {
  @ApiProperty({
    description: "Bearer token to include in the Authorization header for protected endpoints.",
    example: "eyJhbGciOiJIUzI1NiJ9...",
  })
  token!: string;

  @ApiProperty({ example: "Bearer" })
  tokenType!: string;

  @ApiProperty({ example: "1nQ8lZbZxjP4YK2a" })
  sessionId!: string;

  @ApiProperty({ example: "2026-08-25T22:00:00.000Z" })
  expiresAt!: string;
}

export class VerifyResponseDto {
  @ApiProperty({ type: () => VerifyUserDto })
  user!: VerifyUserDto;

  @ApiProperty({ type: () => SessionDto })
  session!: SessionDto;
}
