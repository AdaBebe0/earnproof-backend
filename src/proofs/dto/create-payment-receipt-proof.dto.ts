import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

export class CreatePaymentReceiptProofDto {
  @ApiProperty({ description: "ID of one indexed payment owned by the user." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.id)
  paymentId!: string;

  @ApiPropertyOptional({
    default: false,
    description: "Include the sender address in the public credential.",
  })
  @IsOptional()
  @IsBoolean()
  discloseSender?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: "Include the exact payment amount in the public credential.",
  })
  @IsOptional()
  @IsBoolean()
  discloseAmount?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
