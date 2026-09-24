import { Controller, Get, HttpStatus, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import { CurrentApiKey } from "../common/decorators/current-api-key.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import {
  API_KEY_AUTH_SCHEME,
  ORGANIZATION_ID_HEADER,
} from "../common/swagger/security-schemes";
import { ApiKeyContext } from "./api-key.types";
import { IntegrationAuthContextDto } from "./dto/integration-auth-context.dto";

/**
 * The endpoint an integration calls first.
 *
 * It answers the two questions a machine client has before it does anything
 * else — is this key accepted, and what may it do — without spending a request
 * against a real resource and without a scope the caller may not hold.
 */
@ApiTags("integrations")
@AuthenticatedRoute()
@ApiBearerAuth(API_KEY_AUTH_SCHEME)
@ApiHeader(ORGANIZATION_ID_HEADER)
@Controller("integrations")
export class IntegrationAuthController {
  @Get("auth-context")
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_READ)
  @ApiOperation({
    summary: "Validate an integration key and return its organization context",
    description:
      "Echoes back the non-secret context of the API key that authenticated the " +
      "request: its identifier, its display prefix, the organization it belongs " +
      "to, and the scopes it holds. Integrators use it as a connectivity and " +
      "credential check after issuing or rotating a key.\n\n" +
      "Authentication: `Authorization: Bearer <api key secret>` plus the " +
      "`X-Organization-Id` header. Requires the `ORG_READ` scope.\n\n" +
      "The response never contains the key secret or its hash; neither can be " +
      "reconstructed from any field returned here.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The key is valid and holds the ORG_READ scope.",
    type: IntegrationAuthContextDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      "Missing, malformed, unknown, revoked, or expired key, or a missing " +
      "`X-Organization-Id` header. All of these answer identically so that the " +
      "response cannot be used to probe which keys exist.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      "The key is valid but does not hold the `ORG_READ` scope. Rotate is not " +
      "required — create a key with the scope, or grant it.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded.",
    type: ApiErrorDto,
  })
  authContext(@CurrentApiKey() context: ApiKeyContext): IntegrationAuthContextDto {
    return {
      keyId: context.keyId,
      prefix: context.prefix,
      organizationId: context.organizationId,
      scopes: context.scopes,
    };
  }
}
