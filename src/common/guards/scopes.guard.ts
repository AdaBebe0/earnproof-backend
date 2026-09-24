import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { ApiKeyScope } from "@prisma/client";
import { ApiKeyContext } from "../../api-keys/api-key.types";

/**
 * Scopes Guard - Enforces least-privilege scope access for API keys.
 *
 * Fail-closed default:
 * - Endpoints with @RequireScopes(...) demand ALL specified scopes
 * - Keys with matching scopes are allowed
 * - Keys with missing scopes are rejected with 403 Forbidden
 * - A key with ZERO scopes is rejected from all scope-gated endpoints
 * - Endpoints with NO @RequireScopes decorator allow any authenticated key
 *
 * Response on scope failure:
 * - 403 Forbidden (distinct from 401 for auth failures)
 * - Reason: caller has a valid key but lacks the required permission
 * - Clear message about which scopes are required/missing
 *
 * Used alongside ApiKeyGuard:
 * - ApiKeyGuard: authenticates the key, attaches ApiKeyContext
 * - ScopesGuard: verifies key has required scopes for this endpoint
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Get required scopes from @RequireScopes decorator
    const requiredScopes = this.reflector.get<ApiKeyScope[]>(
      "requiredScopes",
      context.getHandler(),
    );

    // If no scopes required, allow any authenticated request
    // (authentication is handled by ApiKeyGuard)
    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Get API key context attached by ApiKeyGuard
    const apiKeyContext = (
      request as Request & { apiKeyContext?: ApiKeyContext }
    ).apiKeyContext;

    if (!apiKeyContext) {
      // No API key context: not authenticated with API key
      // This guard is only for API key auth; other auth mechanisms are separate
      throw new ForbiddenException(
        "API key authentication required for this endpoint",
      );
    }

    // Check if key has all required scopes (fail-closed)
    const hasAllScopes = requiredScopes.every((requiredScope) =>
      apiKeyContext.scopes.includes(requiredScope),
    );

    if (!hasAllScopes) {
      const missingScopes = requiredScopes.filter(
        (scope) => !apiKeyContext.scopes.includes(scope),
      );

      throw new ForbiddenException(
        `Insufficient scopes. Required: ${requiredScopes.join(", ")}. Missing: ${missingScopes.join(", ")}`,
      );
    }

    return true;
  }
}
