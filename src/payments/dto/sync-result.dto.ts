import { ApiProperty } from "@nestjs/swagger";

export class SyncResultDto {
  @ApiProperty({
    description: "Total number of incoming payment operations fetched from Stellar Horizon.",
    example: 42,
  })
  totalFetched!: number;

  @ApiProperty({
    description: "Number of new payment records created in this sync.",
    example: 10,
  })
  created!: number;

  @ApiProperty({
    description: "Number of existing payment records updated (eligibility / timestamp refreshed).",
    example: 30,
  })
  updated!: number;

  @ApiProperty({
    description: "Number of operations skipped because their asset is not in the supported-asset list.",
    example: 2,
  })
  skipped!: number;
}
