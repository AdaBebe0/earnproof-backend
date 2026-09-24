import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import { ApiKeyContext } from "../../api-keys/api-key.types";

/**
 * Parameter decorator to inject the current API key context into handler methods.
 * Only populated if request was authenticated via ApiKeyGuard.
 *
 * Usage:
 * @Post("/some-endpoint")
 * @UseGuards(ApiKeyGuard, ScopesGuard)
 * @RequireScopes(ApiKeyScope.ORG_ADMIN)
 * someHandler(@CurrentApiKey() apiKey: ApiKeyContext) {
 *   console.log(apiKey.organizationId); // org that key belongs to
 *   console.log(apiKey.prefix); // first 8 chars (safe to log)
 * }
 */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApiKeyContext => {
    const request = context.switchToHttp().getRequest<Request>();
    return (request as Request & { apiKeyContext?: ApiKeyContext })
      .apiKeyContext as ApiKeyContext;
  },
);
