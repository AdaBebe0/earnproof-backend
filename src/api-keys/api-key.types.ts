import { ApiKeyScope } from "@prisma/client";

/**
 * API key context attached to request during authentication.
 * Used by scope guards and handlers to enforce least-privilege access.
 */
export type ApiKeyContext = {
  keyId: string;
  prefix: string; // First 8 characters (non-secret, for logging/display)
  organizationId: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
};
