import { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from "@nestjs/throttler";
import { Request } from "express";
import { SessionService } from "../../auth/session.service";
import { RoleAwareThrottlerGuard } from "./rate-limit.guard";

const THROTTLER_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: "default", ttl: 60_000, limit: 100 }],
};

function fakeStorage(): ThrottlerStorage {
  return {
    increment: jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  } as unknown as ThrottlerStorage;
}

function contextWithRequest(request: Partial<Request>): ExecutionContext {
  const fullRequest = { headers: {}, ip: "127.0.0.1", ...request } as Request;
  return {
    switchToHttp: () => ({
      getRequest: () => fullRequest,
      getResponse: () => ({ header: jest.fn() }),
    }),
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
  } as unknown as ExecutionContext;
}

async function buildGuard(
  authenticatedMultiplier: number,
  tryIdentifyResult?: { sessionId: string; userId: string },
) {
  const configService = {
    get: (_key: string, fallback?: unknown) => authenticatedMultiplier ?? fallback,
  } as unknown as ConfigService;
  const sessionService = {
    tryIdentify: jest.fn().mockResolvedValue(tryIdentifyResult ?? null),
  } as unknown as SessionService;
  const storage = fakeStorage();

  const guard = new RoleAwareThrottlerGuard(
    THROTTLER_OPTIONS,
    storage,
    new Reflector(),
    configService,
    sessionService,
  );
  await guard.onModuleInit();
  return { guard, sessionService, storage };
}

describe("RoleAwareThrottlerGuard", () => {
  describe("getTracker", () => {
    it("tracks by user id when the bearer token maps to a live session", async () => {
      const { guard } = await buildGuard(3, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const request = {
        headers: { authorization: "Bearer sometoken" },
        ip: "1.2.3.4",
      };
      const tracker = await guard["getTracker"](request);
      expect(tracker).toBe("user:user-42");
    });

    it("tracks by IP when there is no authorization header", async () => {
      const { guard } = await buildGuard(3);
      const request = { headers: {}, ip: "1.2.3.4" };
      const tracker = await guard["getTracker"](request);
      expect(tracker).toBe("ip:1.2.3.4");
    });

    it("tracks by IP when the bearer token does not map to a session", async () => {
      const { guard } = await buildGuard(3);
      const request = {
        headers: { authorization: "Bearer garbage" },
        ip: "1.2.3.4",
      };
      const tracker = await guard["getTracker"](request);
      expect(tracker).toBe("ip:1.2.3.4");
    });

    it("does not resolve the session when the header is not a Bearer token", async () => {
      const { guard, sessionService } = await buildGuard(3, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const request = {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
        ip: "1.2.3.4",
      };
      const tracker = await guard["getTracker"](request);
      expect(tracker).toBe("ip:1.2.3.4");
      expect(sessionService.tryIdentify).not.toHaveBeenCalled();
    });
  });

  describe("handleRequest", () => {
    function requestProps(context: ExecutionContext): ThrottlerRequest {
      return {
        context,
        limit: 10,
        ttl: 60_000,
        throttler: { name: "default", limit: 10, ttl: 60_000 },
        blockDuration: 60_000,
        getTracker: async () => "ip:1.2.3.4",
        generateKey: () => "key",
      };
    }

    it("does not scale the limit for an anonymous request", async () => {
      const { guard, storage } = await buildGuard(3);
      const context = contextWithRequest({ headers: {} });

      await guard["handleRequest"](requestProps(context));

      expect(storage.increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        10,
        60_000,
        "default",
      );
    });

    it("scales the limit by the configured multiplier for a live session", async () => {
      const { guard, storage } = await buildGuard(3, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const context = contextWithRequest({
        headers: { authorization: "Bearer validtoken" },
      });

      await guard["handleRequest"](requestProps(context));

      expect(storage.increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        30,
        60_000,
        "default",
      );
    });

    it("does not scale the limit when the multiplier is 1", async () => {
      const { guard, storage } = await buildGuard(1, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const context = contextWithRequest({
        headers: { authorization: "Bearer validtoken" },
      });

      await guard["handleRequest"](requestProps(context));

      expect(storage.increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        10,
        60_000,
        "default",
      );
    });

    it("floors a fractional scaled limit rather than exceeding the budget", async () => {
      const { guard, storage } = await buildGuard(1.5, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const context = contextWithRequest({
        headers: { authorization: "Bearer validtoken" },
      });

      await guard["handleRequest"](requestProps(context));

      expect(storage.increment).toHaveBeenCalledWith(
        expect.any(String),
        60_000,
        15,
        60_000,
        "default",
      );
    });

    it("reuses the cached session lookup for the same request", async () => {
      const { guard, sessionService } = await buildGuard(3, {
        sessionId: "sess-42",
        userId: "user-42",
      });
      const context = contextWithRequest({
        headers: { authorization: "Bearer validtoken" },
        ip: "1.2.3.4",
      });
      const request = context.switchToHttp().getRequest<Request>();

      await guard["getTracker"](request as unknown as Record<string, unknown>);
      await guard["handleRequest"](requestProps(context));

      expect(sessionService.tryIdentify).toHaveBeenCalledTimes(1);
    });
  });
});
