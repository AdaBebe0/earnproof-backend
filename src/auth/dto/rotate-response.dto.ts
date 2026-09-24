import { ApiProperty } from "@nestjs/swagger";

export class RotateResponseDto {
  @ApiProperty({ description: "Fresh opaque bearer token." })
  token!: string;

  @ApiProperty({ example: "Bearer" })
  tokenType!: string;

  @ApiProperty({ example: "1nQ8lZbZxjP4YK2a" })
  sessionId!: string;

  @ApiProperty({ example: "2026-08-25T22:00:00.000Z" })
  expiresAt!: string;
}
