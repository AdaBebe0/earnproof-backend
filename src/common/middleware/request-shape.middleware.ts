import { PayloadTooLargeException } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { findPayloadShapeViolation } from "../limits/payload-shape";
import { PAYLOAD_SHAPE_LIMITS } from "../limits/request-limits";
import { ApiErrorCode } from "../dto/api-error.dto";

/**
 * Rejects structurally abusive bodies immediately after parsing.
 *
 * Placement matters more than the check. As middleware it runs before guards,
 * interceptors, pipes and the handler, so a hostile body is refused before
 * authentication does database work, before the request-scoped machinery is
 * built, and — critically — before class-transformer walks it, which is the
 * step that a deeply nested body is designed to break.
 *
 * The exception carries the stable error code directly, so the global filter
 * passes it through unchanged rather than classifying a 413 as an internal
 * error.
 */
export function requestShapeMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // Only parsed bodies are inspected. A GET has none, and a body the parser
  // rejected never reaches here.
  if (req.body === undefined || req.body === null) {
    next();
    return;
  }

  const violation = findPayloadShapeViolation(req.body, PAYLOAD_SHAPE_LIMITS);

  if (violation) {
    next(
      new PayloadTooLargeException({
        code: ApiErrorCode.PAYLOAD_TOO_LARGE,
        message: violation.message,
      }),
    );
    return;
  }

  next();
}
