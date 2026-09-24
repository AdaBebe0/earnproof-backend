import { ApiProperty } from "@nestjs/swagger";

export class SyncIssuerStatusResponseDto {
  @ApiProperty({ description: "Issuer ID" })
  issuerId: string;

  @ApiProperty({
    description: "Whether the sync was attempted",
  })
  synced: boolean;

  @ApiProperty({
    enum: ["SYNCED", "PENDING", "FAILED", "DISABLED"],
    description: "Durable state of the latest synchronization request",
  })
  state: "SYNCED" | "PENDING" | "FAILED" | "DISABLED";

  @ApiProperty({
    description: "Reason if not synced (disabled, failed, etc.)",
    nullable: true,
  })
  reason?: string;

  @ApiProperty({
    description: "Transaction hash if successfully synced to contract",
    nullable: true,
  })
  transactionHash?: string;

  @ApiProperty({
    description: "Error message if sync failed",
    nullable: true,
  })
  error?: string;

  @ApiProperty({
    description: "Current database status after sync attempt",
  })
  currentStatus: string;

  @ApiProperty({ nullable: true })
  operation?: string;
}
