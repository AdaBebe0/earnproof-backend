import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { METRIC_NAMES } from "../observability/metrics.catalog";
import {
  toRouteLabel,
  toStatusClass,
} from "../observability/metric-labels";
import { MetricsRegistry } from "../observability/metrics.registry";

/**
 * Records the API availability and latency SLIs for every request.
 *
 * Two properties matter here:
 *
 * 1. **Failures are counted.** The `tap` handles both the next and error
 *    channels, so a 5xx is recorded rather than dropped. A latency metric that
 *    silently excludes failures measures the wrong population — precisely the
 *    population an operator cares about during an incident.
 *
 * 2. **Labels stay bounded.** The route label comes from
 *    {@link toRouteLabel}, which collapses anything unrecognised to `other`.
 *    The raw path is never used, so a request to `/proofs/<id>` cannot create a
 *    per-proof series, and an attacker cannot inflate cardinality by walking
 *    made-up paths.
 *
 * The request ID is deliberately *not* a label. It is emitted as a log field by
 * `OperationalLogger` instead; see the correlation section of
 * `docs/observability.md`.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsRegistry) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const route = toRouteLabel(req.path ?? req.url ?? "/");
    const method = normaliseMethod(req.method);
    const startedAt = Date.now();

    const record = (statusCode: number): void => {
      const durationMs = Date.now() - startedAt;

      this.metrics.increment(METRIC_NAMES.httpRequestsTotal, {
        route,
        method,
        status_class: toStatusClass(statusCode),
      });

      this.metrics.observe(METRIC_NAMES.httpRequestDurationMs, durationMs, {
        route,
        method,
      });
    };

    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode ?? 200),
        error: (error: unknown) => record(resolveErrorStatus(error, res)),
      }),
    );
  }
}

/**
 * Maps a request method onto the bounded `method` vocabulary.
 *
 * An unrecognised verb — HEAD, OPTIONS, or something arbitrary — would be
 * rejected by the registry, so it is folded into GET rather than being allowed
 * to throw inside an interceptor and turn an observability concern into a
 * request failure.
 */
function normaliseMethod(method: string | undefined): string {
  const upper = (method ?? "GET").toUpperCase();
  return ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(upper)
    ? upper
    : "GET";
}

/**
 * Determines the status to record when the handler threw.
 *
 * The response status is often still 200 at the point the error propagates,
 * because the exception filter has not run yet. The thrown value's own status
 * is the more accurate signal when it carries one.
 */
function resolveErrorStatus(error: unknown, res: Response): number {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;

    if (status && status >= 100 && status < 600) return status;
  }

  const current = res.statusCode ?? 500;
  return current >= 400 ? current : 500;
}
