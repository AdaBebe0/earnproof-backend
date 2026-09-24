import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class ListTrustedSourcesDto {
  @ApiPropertyOptional({
    description: "Filter by source address (substring match)",
    example: "GB",
  })
  @IsOptional()
  @IsString()
  sourceAddress?: string;

  @ApiPropertyOptional({
    description: "Filter by source type",
    example: "stellar",
  })
  @IsOptional()
  @IsString()
  sourceType?: string;
}
