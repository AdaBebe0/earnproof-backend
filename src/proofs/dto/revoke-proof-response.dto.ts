import { ApiProperty } from "@nestjs/swagger";
import { ProofStatus } from "@prisma/client";
import { AnchoringResultDto } from "./proof-created.dto";

export class RevokeProofResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({ enum: ProofStatus, example: ProofStatus.REVOKED })
  status!: ProofStatus;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the proof was revoked.",
    example: "2025-01-20T15:30:00.000Z",
  })
  revokedAt!: string;

  @ApiProperty({ type: () => AnchoringResultDto })
  anchoring!: AnchoringResultDto;
}
