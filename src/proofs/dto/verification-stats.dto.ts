import { ApiProperty } from "@nestjs/swagger";

export class VerificationStatsDto {
  @ApiProperty({ example: 12 })
  VALID!: number;

  @ApiProperty({ example: 1 })
  EXPIRED!: number;

  @ApiProperty({ example: 2 })
  REVOKED!: number;

  @ApiProperty({ example: 0 })
  UNKNOWN!: number;

  @ApiProperty({ example: 0 })
  INVALID_SIGNATURE!: number;

  @ApiProperty({ example: 0 })
  ISSUER_WARNING!: number;
}
