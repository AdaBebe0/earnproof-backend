import { ApiProperty } from "@nestjs/swagger";

export class LogoutResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;
}
