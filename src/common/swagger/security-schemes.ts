import { HttpStatus } from "@nestjs/common";
import type { ApiResponseOptions } from "@nestjs/swagger";
import type { SecuritySchemeObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { ApiErrorDto } from "../dto/api-error.dto";

/**
 * Security scheme names shared by the document builder and the controllers.
 *
 * The name passed to `@ApiBearerAuth()` has to match the name the scheme was
 * registered under, and a mismatch is invisible: the endpoint simply renders
 * without an authorize button. Naming both ends from one constant is what keeps
 * the two in step, and lets the OpenAPI test build the same document the server
 * serves.
 */
export const SESSION_AUTH_SCHEME = "bearer";
export const API_KEY_AUTH_SCHEME = "api-key";

/** Wallet session token issued by `POST /api/v1/auth/verify`. */
export const SESSION_AUTH_SCHEME_DEFINITION: SecuritySchemeObject = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Opaque session token",
  description:
    "Bearer token obtained from `POST /api/v1/auth/verify`. " +
    "Include as `Authorization: Bearer <token>`.",
};

/**
 * Machine-to-machine API key.
 *
 * Presented the same way as a session token, so it needs its own scheme rather
 * than a shared one: the two credentials are not interchangeable, and an API key
 * additionally requires the `X-Organization-Id` header naming the organization
 * it belongs to.
 */
export const API_KEY_AUTH_SCHEME_DEFINITION: SecuritySchemeObject = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API key secret",
  description:
    "API key created through `POST /api/v1/api-keys`. Include as " +
    "`Authorization: Bearer <secret>` together with the `X-Organization-Id` " +
    "header naming the owning organization. A key only grants the scopes it " +
    "was created with.",
};

/**
 * The `X-Organization-Id` header every API-key-authenticated route requires.
 *
 * Documented here because the guard reads it, not a route parameter, so nothing
 * in a handler signature would otherwise reveal it to a reader of `/docs`.
 */
export const ORGANIZATION_ID_HEADER = {
  name: "X-Organization-Id",
  description:
    "Organization that owns the presented API key. Required: a key is only " +
    "resolvable within its own organization.",
  required: true,
  schema: { type: "string" as const, example: "ckv8v6h2b0001qzrm6ap0hf3d" },
};

/**
 * Responses every route can return, documented once.
 *
 * The throttler is a global guard and the exception filter turns any unhandled
 * error into the same envelope, so repeating these on ~50 operations would be
 * noise that drifts. `addGlobalResponse` merges them into every operation
 * instead, leaving per-route decorators to say what is specific to that route.
 */
export const GLOBAL_API_RESPONSES: ApiResponseOptions[] = [
  {
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      "Rate limit exceeded. Every route is behind a global limiter, and some " +
      "routes tighten it further; the limit that applied is named in the route's " +
      "own documentation where it differs.",
    type: ApiErrorDto,
  },
  {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description:
      "Unhandled server error. The response carries the same error envelope as " +
      "every other failure, including the `requestId` to quote in a report.",
    type: ApiErrorDto,
  },
];
