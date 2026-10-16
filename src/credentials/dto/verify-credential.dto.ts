import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";
import { MaxBytes, MaxDepth } from "../../common/validation/payload-limits";

/**
 * The one endpoint that legitimately accepts a document.
 *
 * A verifier posts a credential it was given, so the field cannot be typed more
 * tightly than "an object" — which is exactly why it carries explicit size and
 * depth bounds. The transport limit for this route sits just above the byte cap
 * here, so a body too large to be a valid credential is refused before it is
 * parsed. See `src/common/limits/request-limits.ts`.
 */
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32 KB
const MAX_PAYLOAD_DEPTH = 5;

export class VerifyCredentialDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The credential document as issued, including its `proof` block. At most " +
      `${MAX_PAYLOAD_BYTES / 1024} KB and ${MAX_PAYLOAD_DEPTH} levels of nesting; ` +
      "larger or deeper submissions are refused before verification runs.",
  })
  @IsObject()
  @MaxBytes(MAX_PAYLOAD_BYTES)
  @MaxDepth(MAX_PAYLOAD_DEPTH)
  credential!: Record<string, unknown>;
}
