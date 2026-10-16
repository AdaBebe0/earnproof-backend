import { Controller, Get, INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { SessionService } from "../../auth/session.service";
import { configuration } from "../../config/configuration";
import { DatabaseModule } from "../../database/database.module";
import { PrismaService } from "../../database/prisma.service";
import { RateLimitModule } from "./rate-limit.module";

@Controller("test")
class TestController {
  @Get("default")
  defaultTier() {
    return { ok: true };
  }

  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Get("strict")
  strictTier() {
    return { ok: true };
  }

  @SkipThrottle({ default: true, strict: true, verification: true })
  @Get("health")
  health() {
    return { ok: true };
  }
}

describe("Rate limiting (#112) - integration", () => {
  let app: INestApplication;
  let sessionService: jest.Mocked<Pick<SessionService, "tryIdentify">>;

  beforeAll(async () => {
    process.env.RATE_LIMIT_STRICT_LIMIT = "2";
    process.env.RATE_LIMIT_STRICT_TTL_MS = "60000";
    process.env.RATE_LIMIT_DEFAULT_LIMIT = "3";
    process.env.RATE_LIMIT_DEFAULT_TTL_MS = "60000";
    process.env.RATE_LIMIT_AUTHENTICATED_MULTIPLIER = "3";
    process.env.SESSION_SECRET = "test_secret_for_rate_limit_integration";

    const sessionServiceMock: jest.Mocked<Pick<SessionService, "tryIdentify">> =
      {
        tryIdentify: jest.fn().mockResolvedValue(null),
      };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        DatabaseModule,
        RateLimitModule,
      ],
      controllers: [TestController],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SessionService)
      .useValue(sessionServiceMock)
      .compile();

    app = moduleRef.createNestApplication();
    sessionService = moduleRef.get(SessionService);
    await app.init();
  });

  beforeEach(() => {
    sessionService.tryIdentify.mockResolvedValue(null);
    sessionService.tryIdentify.mockClear();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.RATE_LIMIT_STRICT_LIMIT;
    delete process.env.RATE_LIMIT_STRICT_TTL_MS;
    delete process.env.RATE_LIMIT_DEFAULT_LIMIT;
    delete process.env.RATE_LIMIT_DEFAULT_TTL_MS;
    delete process.env.RATE_LIMIT_AUTHENTICATED_MULTIPLIER;
    delete process.env.SESSION_SECRET;
  });

  it("includes X-RateLimit-* headers on a normal response", async () => {
    const res = await request(app.getHttpServer()).get("/test/default").expect(200);

    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("rejects with 429 and a Retry-After header once the strict threshold is exceeded", async () => {
    const agent = request.agent(app.getHttpServer());

    await agent.get("/test/strict").expect(200);
    await agent.get("/test/strict").expect(200);
    const blocked = await agent.get("/test/strict").expect(429);

    expect(blocked.headers["retry-after-strict"]).toBeDefined();
    expect(Number(blocked.headers["retry-after-strict"])).toBeGreaterThan(0);
  });

  it("never rate-limits a route marked @SkipThrottle() regardless of volume", async () => {
    const agent = request.agent(app.getHttpServer());

    for (let i = 0; i < 10; i += 1) {
      await agent.get("/test/health").expect(200);
    }
  });

  it("gives a live session caller a higher effective limit than an anonymous one", async () => {
    const token = `${"A".repeat(16)}.${"a".repeat(64)}`;
    sessionService.tryIdentify.mockResolvedValue({
      sessionId: "session-rate-limit",
      userId: "integration-test-user",
    });

    const agent = request.agent(app.getHttpServer());
    for (let i = 0; i < 5; i += 1) {
      await agent
        .get("/test/default")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    }
  });
});
