import { ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { RequestIdInterceptor, REQUEST_ID_HEADER } from "./request-id.interceptor";

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

function makeContext(incomingHeaders: Record<string, string> = {}): {
  context: ExecutionContext;
  request: { headers: Record<string, string>; requestId?: string };
  responseHeaders: Record<string, string>;
} {
  const responseHeaders: Record<string, string> = {};
  const request: { headers: Record<string, string>; requestId?: string } = {
    headers: { ...incomingHeaders },
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          responseHeaders[name.toLowerCase()] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;

  return { context, request, responseHeaders };
}

function runInterceptor(
  interceptor: RequestIdInterceptor,
  context: ExecutionContext,
): void {
  // Subscribe to force the observable to execute synchronously.
  interceptor.intercept(context, { handle: () => of(null) }).subscribe();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RequestIdInterceptor", () => {
  let interceptor: RequestIdInterceptor;

  beforeEach(() => {
    interceptor = new RequestIdInterceptor();
  });

  describe("when no X-Request-ID is supplied", () => {
    it("generates a 32-character hex request ID", () => {
      const { context, request } = makeContext();
      runInterceptor(interceptor, context);
      expect(request.requestId).toMatch(/^[a-f0-9]{32}$/);
    });

    it("sets the X-Request-ID response header to the generated value", () => {
      const { context, request, responseHeaders } = makeContext();
      runInterceptor(interceptor, context);
      expect(responseHeaders[REQUEST_ID_HEADER]).toBe(request.requestId);
    });
  });

  describe("when a valid X-Request-ID is supplied", () => {
    it("passes the incoming ID through unchanged", () => {
      const { context, request } = makeContext({
        [REQUEST_ID_HEADER]: "my-custom-id-1234",
      });
      runInterceptor(interceptor, context);
      expect(request.requestId).toBe("my-custom-id-1234");
    });

    it("echoes the same ID in the response header", () => {
      const { context, responseHeaders } = makeContext({
        [REQUEST_ID_HEADER]: "my-custom-id-1234",
      });
      runInterceptor(interceptor, context);
      expect(responseHeaders[REQUEST_ID_HEADER]).toBe("my-custom-id-1234");
    });

    it("accepts IDs up to 128 characters long", () => {
      const longId = "a".repeat(128);
      const { context, request } = makeContext({ [REQUEST_ID_HEADER]: longId });
      runInterceptor(interceptor, context);
      expect(request.requestId).toBe(longId);
    });

    it("accepts IDs containing hyphens and underscores", () => {
      const id = "req_abc-123-DEF";
      const { context, request } = makeContext({ [REQUEST_ID_HEADER]: id });
      runInterceptor(interceptor, context);
      expect(request.requestId).toBe(id);
    });
  });

  describe("when an unsafe X-Request-ID is supplied", () => {
    const unsafeCases = [
      ["script injection", "<script>alert(1)</script>"],
      ["spaces", "id with spaces"],
      ["too long (>128 chars)", "a".repeat(129)],
      ["empty string", ""],
    ];

    it.each(unsafeCases)("%s is replaced with a generated ID", (_label, badId) => {
      const { context, request } = makeContext({ [REQUEST_ID_HEADER]: badId });
      runInterceptor(interceptor, context);
      // Generated IDs are 32-char hex; incoming bad values must not appear.
      expect(request.requestId).not.toBe(badId);
      expect(request.requestId).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  describe("correlation between request and response", () => {
    it("req.requestId always matches the X-Request-ID response header", () => {
      // Run several times to catch any non-determinism.
      for (let i = 0; i < 5; i++) {
        const { context, request, responseHeaders } = makeContext();
        runInterceptor(interceptor, context);
        expect(responseHeaders[REQUEST_ID_HEADER]).toBe(request.requestId);
      }
    });
  });

  describe("generated IDs are unique", () => {
    it("does not generate the same ID twice across 100 invocations", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const { context, request } = makeContext();
        runInterceptor(interceptor, context);
        ids.add(request.requestId as string);
      }
      expect(ids.size).toBe(100);
    });
  });
});
