import { ApiProperty } from "@nestjs/swagger";
import type {
  VerifyCredentialResponse,
  VerifyCredentialResult,
} from "../credentials.service";

/**
 * What each verification outcome means, in the words a verifier needs.
 *
 * Keyed by the result union rather than listed loosely, so a new outcome added
 * to the service fails to compile until it is documented here — which is the
 * only way a published contract stays honest as the domain grows.
 */
const RESULT_DESCRIPTIONS: Record<VerifyCredentialResult, string> = {
  valid: "Signature, anchor, status and expiry all check out. Accept the claim.",
  invalid_signature:
    "The credential does not match its own hash or signature. Treat it as forged or corrupted.",
  unsupported_schema:
    "The credential is not a schema version this deployment verifies.",
  unsupported_key: "The proof block uses a signature algorithm this API does not verify.",
  unknown_anchor:
    "Well-formed and correctly signed, but no matching proof is recorded here. It was not issued by this deployment.",
  revoked: "The issuing worker or an administrator revoked this credential.",
  expired: "The credential is past its validity window.",
  unverified_issuer:
    "The proof exists but is not in an active, trusted state — for example still pending anchoring.",
};

/** Every outcome the verification endpoint can return. */
export const VERIFY_CREDENTIAL_RESULTS = Object.keys(
  RESULT_DESCRIPTIONS,
) as VerifyCredentialResult[];

export class VerifyCredentialResponseDto implements VerifyCredentialResponse {
  @ApiProperty({
    description: [
      "Verification outcome. Branch on this value, never on the HTTP status: a",
      "credential that is forged, revoked or expired is still a successful",
      "request and answers 200.",
      "",
      ...VERIFY_CREDENTIAL_RESULTS.map(
        (result) => `- \`${result}\` — ${RESULT_DESCRIPTIONS[result]}`,
      ),
    ].join("\n"),
    enum: VERIFY_CREDENTIAL_RESULTS,
    example: "valid",
  })
  result!: VerifyCredentialResult;
}
