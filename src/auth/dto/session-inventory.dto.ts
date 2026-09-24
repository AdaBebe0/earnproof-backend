import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SessionInventoryItemDto {
  @ApiProperty({ example: "sess_abc123" })
  id!: string;

  @ApiProperty({ example: "Chrome on macOS on Desktop" })
  deviceLabel!: string;

  @ApiProperty({ example: "2026-09-24T12:00:00.000Z" })
  firstSeenAt!: Date;

  @ApiProperty({ example: "2026-09-24T13:00:00.000Z" })
  lastSeenAt!: Date;

  @ApiProperty({ example: "2026-09-25T00:00:00.000Z" })
  expiresAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  revokedAt!: Date | null;

  @ApiProperty({ example: true })
  current!: boolean;
}
