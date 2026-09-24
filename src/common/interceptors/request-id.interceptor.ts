import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { randomBytes } from "crypto";
import { Observable } from "rxjs";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Generates or propagates a request-scoped ID.
 *
 * - If the incoming request already carries an `X-Request-ID` header the value
 *   is accepted as-is (trimmed, max 128 chars, alphanumeric/hyphen only).
 *   Any value that fails validation is replaced with a freshly-generated one.
 * - A new ID is always a 16-byte random hex string.
 * - The resolved ID is attached to `request.requestId` so that the global
 *   exception filter and other middleware can include it in responses.
 * - The same value is echoed back in the `X-Request-ID` response header.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  private static readonly SAFE_PATTERN = /^[a-zA-Z0-9\-_]{1,128}$/;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();

    const incoming = req.headers[REQUEST_ID_HEADER];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    const candidate = raw?.trim() ?? "";

    const requestId = RequestIdInterceptor.SAFE_PATTERN.test(candidate)
      ? candidate
      : randomBytes(16).toString("hex");

    // Attach to the request object so the exception filter can read it even
    // before a response is written.
    req.requestId = requestId;

    // Echo the resolved ID back so clients can correlate logs.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    return next.handle();
  }
}
