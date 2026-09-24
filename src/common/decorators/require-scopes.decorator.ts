import { SetMetadata } from "@nestjs/common";
import { ApiKeyScope } from "@prisma/client";

/**
 * Decorator to specify required scopes for an endpoint.
 * Used in conjunction with the ScopesGuard to enforce least-privilege access.
 *
 * Usage:
 * @RequireScopes(ApiKeyScope.PROOF_VERIFY)
 * @Get(":id/verify")
 * verifyProof(@Param("id") id: string) {
 *   // This endpoint requires PROOF_VERIFY scope
 * }
 *
 * Multiple scopes are combined with AND logic (all required).
 * If no scopes are specified, the endpoint has no scope requirement (open access).
 * Note: endpoints that manage API keys themselves should be protected at role-level, not scope-level.
 *
 * Security: Fail-closed default
 * - A key with NO scopes is rejected from all scope-gated endpoints
 * - An endpoint with NO @RequireScopes decorator accepts any authenticated key
 * - Mismatch results in 403 Forbidden with clear scope-related message
 */
export const RequireScopes = (...scopes: ApiKeyScope[]) =>
  SetMetadata("requiredScopes", scopes);
