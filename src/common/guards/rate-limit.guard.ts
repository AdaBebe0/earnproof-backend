import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from "@nestjs/throttler";
import { Request } from "express";
import { SessionIdentity, SessionService } from "../../auth/session.service";

const RATE_LIMIT_SESSION_CACHE = Symbol("rateLimitSessionCache");

type RateLimitRequest = Request & {
  [RATE_LIMIT_SESSION_CACHE]?: Promise<SessionIdentity | null>;
};

/**
 * Role-aware global throttling.
 *
 * The stock throttler resolves fixed named limits at startup. This guard keeps
 * those configured limits as the base tier, then multiplies the active limit
 * when the bearer token maps to a live persisted session. Missing, malformed,
 * expired, revoked, or temporarily unresolved tokens fall back to the
 * anonymous IP bucket and are never rejected here; route-level AuthGuard owns
 * authentication enforcement.
 */
@Injectable()
export class RoleAwareThrottlerGuard extends ThrottlerGuard {
  private readonly authenticatedMultiplier: number;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    configService: ConfigService,
    private readonly sessionService: SessionService,
  ) {
    super(options, storageService, reflector);
    this.authenticatedMultiplier = configService.get<number>(
      "rateLimit.authenticatedMultiplier",
      1,
    );
  }

  private authenticatedSession(
    request: RateLimitRequest,
  ): Promise<SessionIdentity | null> {
    const cached = request[RATE_LIMIT_SESSION_CACHE];
    if (cached) return cached;

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return Promise.resolve(null);
    }

    const lookup = this.sessionService.tryIdentify(
      header.slice("Bearer ".length),
    );
    request[RATE_LIMIT_SESSION_CACHE] = lookup;
    return lookup;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as RateLimitRequest;
    const session = await this.authenticatedSession(request);
    return session ? `user:${session.userId}` : `ip:${request.ip}`;
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const request = requestProps.context
      .switchToHttp()
      .getRequest<RateLimitRequest>();
    const isAuthenticated = Boolean(await this.authenticatedSession(request));

    if (!isAuthenticated || this.authenticatedMultiplier <= 1) {
      return super.handleRequest(requestProps);
    }

    const scaled: ThrottlerRequest = {
      ...requestProps,
      limit: Math.floor(requestProps.limit * this.authenticatedMultiplier),
    };
    return super.handleRequest(scaled);
  }
}
