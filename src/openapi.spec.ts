import SwaggerParser from "@apidevtools/swagger-parser";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
} from "@nestjs/swagger";
import type { OperationObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { ApiErrorDto, FieldViolationDto } from "./common/dto/api-error.dto";
import {
  API_KEY_AUTH_SCHEME,
  API_KEY_AUTH_SCHEME_DEFINITION,
  GLOBAL_API_RESPONSES,
  SESSION_AUTH_SCHEME,
  SESSION_AUTH_SCHEME_DEFINITION,
} from "./common/swagger/security-schemes";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;

describe("generated OpenAPI document", () => {
  const originalEnv = process.env;
  let app: INestApplication;

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      APP_URL: "http://localhost:3000",
      API_URL: "http://localhost:4000",
      CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
      DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "session_secret_123",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      STELLAR_NETWORK: "testnet",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    };
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
  });

  afterAll(async () => {
    await app.close();
    process.env = originalEnv;
  });

  /**
   * The same document `main.ts` serves at `/docs`.
   *
   * Built from the shared scheme definitions rather than a hand-rolled copy, so
   * a security scheme added to the server but not here cannot pass silently.
   */
  function buildDocument(): OpenAPIObject {
    const config = new DocumentBuilder()
      .setTitle("EarnProof API")
      .setVersion("0.1.0")
      .addBearerAuth(SESSION_AUTH_SCHEME_DEFINITION, SESSION_AUTH_SCHEME)
      .addBearerAuth(API_KEY_AUTH_SCHEME_DEFINITION, API_KEY_AUTH_SCHEME)
      .addGlobalResponse(...GLOBAL_API_RESPONSES)
      .build();

    return SwaggerModule.createDocument(app, config, {
      extraModels: [ApiErrorDto, FieldViolationDto],
    });
  }

  /** Every operation in the document, as [route, method, operation] triples. */
  function operations(document: OpenAPIObject) {
    const found: [string, string, OperationObject][] = [];

    for (const [route, item] of Object.entries(document.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = (item as Record<string, OperationObject | undefined>)[
          method
        ];
        if (operation) found.push([route, method, operation]);
      }
    }

    return found;
  }

  it("passes schema validation and documents every endpoint", async () => {
    const document = buildDocument();

    await expect(
      SwaggerParser.validate(document as never),
    ).resolves.toBeDefined();
    expect(document.paths).toHaveProperty(
      "/api/v1/proofs/{id}/verification-stats.get",
    );
    expect(document.paths).toHaveProperty("/api/v1/proofs.get");
    expect(document.paths).toHaveProperty("/api/v1/proofs/{id}.get");
    expect(document.paths).toHaveProperty("/api/v1/payments.get");
    expect(document.paths).toHaveProperty(
      "/api/v1/proofs/payment-receipt.post",
    );
    expect(document.paths).toHaveProperty("/api/v1/issuers.get");
    expect(document.paths).toHaveProperty("/api/v1/issuers/{id}.get");
    expect(document.paths).toHaveProperty("/api/v1/issuers/admin.get");
    expect(document.paths).toHaveProperty("/api/v1/organizations.get");
    expect(document.paths).toHaveProperty("/api/v1/auth/verify.post");
    expect(document.paths).toHaveProperty("/api/v1/credentials/verify.post");
    expect(document.paths).toHaveProperty(
      "/api/v1/integrations/auth-context.get",
    );
    expect(document.paths).toHaveProperty("/api/v1/api-keys/{id}.delete");
    expect(document.paths).toHaveProperty("/api/v1/webhooks.post");
    expect(document.paths).toHaveProperty(
      "/api/v1/webhooks/deliveries/{deliveryId}/replay.post",
    );
  });

  it("gives every operation a summary", () => {
    // An endpoint without a summary is invisible in the Swagger UI sidebar: it
    // renders as a bare method and path, which is exactly the state issue #104
    // found the integration and credential routes in.
    const undocumented = operations(buildDocument())
      .filter(([, , operation]) => !operation.summary)
      .map(([route, method]) => `${method.toUpperCase()} ${route}`);

    expect(undocumented).toEqual([]);
  });

  it("documents a failure response for every operation", () => {
    // A consumer that only knows the success shape has to discover error
    // handling in production. The globally merged responses cover throttling and
    // unhandled errors; this fails if that merge ever stops happening.
    const missingFailures = operations(buildDocument())
      .filter(
        ([, , operation]) =>
          !Object.keys(operation.responses ?? {}).some((status) =>
            /^[45]/.test(status),
          ),
      )
      .map(([route, method]) => `${method.toUpperCase()} ${route}`);

    expect(missingFailures).toEqual([]);
  });

  it("documents 401 on every operation that requires a credential", () => {
    // The failure an integrator meets first is the one they are least often
    // told about: a guarded route that documents only its success shape reads as
    // though a missing or stale token were impossible.
    const missing401 = operations(buildDocument())
      .filter(([, , operation]) => (operation.security ?? []).length > 0)
      .filter(([, , operation]) => !("401" in (operation.responses ?? {})))
      .map(([route, method]) => `${method.toUpperCase()} ${route}`);

    expect(missing401).toEqual([]);
  });

  it("only requires security schemes the document defines", () => {
    // @ApiBearerAuth("name") with an unregistered name fails open: the endpoint
    // renders without an authorize button and reads as public.
    const document = buildDocument();
    const defined = Object.keys(document.components?.securitySchemes ?? {});

    const dangling = operations(document).flatMap(([route, method, operation]) =>
      (operation.security ?? [])
        .flatMap((requirement) => Object.keys(requirement))
        .filter((scheme) => !defined.includes(scheme))
        .map((scheme) => `${method.toUpperCase()} ${route} -> ${scheme}`),
    );

    expect(defined).toEqual(
      expect.arrayContaining([SESSION_AUTH_SCHEME, API_KEY_AUTH_SCHEME]),
    );
    expect(dangling).toEqual([]);
  });
});
