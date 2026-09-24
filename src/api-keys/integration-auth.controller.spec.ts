import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ApiKeyScope } from "@prisma/client";
import { Request } from "express";
import * as request from "supertest";
import { configureApp } from "../bootstrap";
import { IntegrationAuthController } from "./integration-auth.controller";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ApiKeyContext } from "./api-key.types";

/**
 * HTTP-level tests for IntegrationAuthController (#108).
 *
 * `ApiKeyGuard` and `ScopesGuard` each have their own responsibility
 * (authenticate the key; enforce the endpoint's required scopes), and their
 * own internal correctness is not this file's concern. What matters here is
 * that the CONTROLLER behaves correctly for each guard outcome: a request
 * that clears both guards reaches the handler and gets the expected response
 * shape; a request either guard rejects gets the right status code and never
 * reaches the handler. `ApiKeyGuard` is overridden with a lightweight fake
 * (its own DB-backed lookup logic is out of scope here); the real
 * `ScopesGuard` is left in place since exercising the controller's actual
 * `@RequireScopes(ORG_READ)` wiring end-to-end is exactly the point.
 */
describe("IntegrationAuthController (HTTP)", () => {
  let app: INestApplication;

  const VALID_CONTEXT: ApiKeyContext = {
    keyId: "key_1",
    prefix: "abcd1234",
    organizationId: "org_1",
    scopes: [ApiKeyScope.ORG_READ],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  /** A fake ApiKeyGuard: attaches `apiKeyContext` based on a test marker header. */
  class FakeApiKeyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<Request>();
      const outcome = req.headers["x-test-auth-outcome"];

      if (outcome === "unauthenticated") {
        throw new UnauthorizedException("Invalid API key");
      }

      (req as Request & { apiKeyContext?: ApiKeyContext }).apiKeyContext =
        outcome === "no-scopes" ? { ...VALID_CONTEXT, scopes: [] } : VALID_CONTEXT;
      return true;
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationAuthController],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue(new FakeApiKeyGuard())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /integrations/auth-context", () => {
    it("returns 200 with the safe organization context when authenticated with a sufficiently scoped key", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/integrations/auth-context")
        .set("x-test-auth-outcome", "authenticated");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        keyId: "key_1",
        prefix: "abcd1234",
        organizationId: "org_1",
        scopes: [ApiKeyScope.ORG_READ],
      });
    });

    it("never returns the createdAt timestamp or any other non-whitelisted field", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/integrations/auth-context")
        .set("x-test-auth-outcome", "authenticated");

      expect(res.body).not.toHaveProperty("createdAt");
    });

    it("returns 401 when ApiKeyGuard rejects the request", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/integrations/auth-context")
        .set("x-test-auth-outcome", "unauthenticated");

      expect(res.status).toBe(401);
    });

    it("returns 403 when the key is authenticated but lacks the required ORG_READ scope", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/integrations/auth-context")
        .set("x-test-auth-outcome", "no-scopes");

      expect(res.status).toBe(403);
    });
  });
});
