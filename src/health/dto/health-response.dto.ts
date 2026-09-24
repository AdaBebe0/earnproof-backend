import { ApiProperty } from "@nestjs/swagger";

export class HealthResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;

  @ApiProperty({ example: "earnproof-api" })
  service!: string;

  @ApiProperty({
    description: "Database connectivity status.",
    example: "ok",
    enum: ["ok", "error"],
  })
  database!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp of when the health check was performed.",
    example: "2025-01-15T12:00:00.000Z",
  })
  timestamp!: string;
}
