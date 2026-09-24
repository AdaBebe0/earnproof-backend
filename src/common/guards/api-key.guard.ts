import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { ApiKeyService } from "../../api-keys/api-key.service";
import { ApiKeyContext } from "../../api-keys/api-key.types";

/**
 * API Key Authentication Guard
 *
 * Authenticates requests bearing an API key in the Authorization header.
 * Format: Authorization: Bearer <key>
 *
 * Response strategy (requirement #7 - stable failure responses):
 * - All authentication failures (not found, invalid, revoked, expired) return 401 Unauthorized
 * - Uniform response masks whether the key doesn't exist, is revoked, or is expired
 * - This prevents attackers from probing to determine which keys are real
 * - Scope failures (valid key but lacks required scope) return 403 Forbidden separately
 *   via the @RequireScopes guard, since the caller already proved key validity
 *
 * Implementation:
 * - Parse Authorization header looking for "Bearer <key>"
 * - Extract prefix (first 8 chars) and lookup by prefix + organization
 * - Verify presented key against stored hash using constant-time comparison
 * - Attach ApiKeyContext to request for downstream use by handlers and scope guards
 * - Record key usage (non-identifying timestamp only)
 * - Return false (reject) if any step fails
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Extract Authorization header
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Invalid API key");
    }

    const presentedKey = authHeader.slice("Bearer ".length);

    // Parse presented key: first 8 chars = prefix
    if (!/^[A-Za-z0-9_-]{43}$/.test(presentedKey)) {
      throw new UnauthorizedException("Invalid API key");
    }

    const prefix = presentedKey.substring(0, 8);

    // Organization must be known at this point (or passed from earlier middleware/header)
    // For now, we'll extract it from a custom header or fallback
    // In a real system, this might come from a subdomain, path, or explicit header
    const organizationId = this.extractOrganizationId(request);
    if (!organizationId) {
      throw new UnauthorizedException("Invalid API key");
    }

    try {
      // Lookup and verify the key
      const apiKey = await this.apiKeyService.lookupAndVerifyKey(
        prefix,
        presentedKey,
        organizationId,
      );

      if (!apiKey) {
        // Failure: key not found, invalid, revoked, expired, or wrong hash
        // Respond uniformly to avoid information leakage
        throw new UnauthorizedException("Invalid API key");
      }

      // Attach context to request for handlers and scope guards
      const apiKeyContext: ApiKeyContext = {
        keyId: apiKey.id,
        prefix: apiKey.prefix,
        organizationId: apiKey.organizationId,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        createdAt: apiKey.createdAt,
      };

      // Store in request for retrieval by handlers
      (request as Request & { apiKeyContext?: ApiKeyContext }).apiKeyContext =
        apiKeyContext;

      // Record usage (timestamp only, no IP/UA)
      await this.apiKeyService.recordKeyUsage(apiKey.id, apiKey.organizationId);

      return true; // Authentication successful
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error; // Re-throw auth errors as-is
      }

      // Catch any other errors and respond with generic 401
      throw new UnauthorizedException("Invalid API key");
    }
  }

  /**
   * Extract organization ID from request context.
   * Implementation depends on how organization context is passed in this system.
   * Could be from:
   * - X-Organization-Id header (explicit)
   * - Subdomain (e.g., api.org-slug.example.com)
   * - Path parameter (/api/v1/orgs/:orgId/...)
   * - Session context (if user is authenticated separately)
   *
   * For now, implement support for X-Organization-Id header for flexibility.
   */
  private extractOrganizationId(request: Request): string | null {
    // Check for explicit X-Organization-Id header
    const orgIdHeader = request.headers["x-organization-id"];
    if (typeof orgIdHeader === "string") {
      return orgIdHeader;
    }

    // Could add other extraction strategies here:
    // - Extract from subdomain
    // - Extract from path
    // - Extract from authenticated user context (if wallet auth is also present)

    return null;
  }
}
