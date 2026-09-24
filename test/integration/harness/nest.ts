import { ConfigModule } from "@nestjs/config";
import { Provider, Type } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { configuration } from "../../../src/config/configuration";
import { validateEnv } from "../../../src/config/env.validation";
import { DatabaseModule } from "../../../src/database/database.module";
import { withDeadline } from "./bounded";
import { integrationConfig } from "./config";

/**
 * Builds a Nest injector containing the real providers under test.
 *
 * Deliberately not `AppModule`. Booting the whole application would start the
 * scheduler, the anchoring worker, and the webhook delivery queue — background
 * work with timers and outbound HTTP that has nothing to do with the behaviour
 * being tested and everything to do with a suite that hangs on teardown. A
 * narrow module gives the same providers, wired the same way, with a bounded
 * lifecycle.
 *
 * `DatabaseModule` is included unchanged, so `PrismaService` is the same class
 * production uses. It reads `DATABASE_URL`, which the worker environment has
 * already pointed at this worker's database.
 *
 * Call this after `integrationDatabase()` in the same file: that call registers
 * the `beforeAll` which creates the worker database, and Jest runs `beforeAll`
 * hooks in registration order.
 */
export function integrationModule(providers: Array<Type<unknown> | Provider>) {
  const config = integrationConfig();
  let moduleRef: TestingModule | undefined;

  const handle = {
    get<T>(token: Type<T> | string | symbol): T {
      if (!moduleRef) {
        throw new Error(
          "The integration module is only available inside a test or hook; it is created in beforeAll.",
        );
      }
      return moduleRef.get<T>(token as Type<T>, { strict: false });
    },
  };

  beforeAll(async () => {
    moduleRef = await withDeadline(
      "Creating the Nest testing module",
      config.adminTimeoutMs,
      () =>
        Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              load: [configuration],
              validate: validateEnv,
            }),
            DatabaseModule,
          ],
          providers,
        }).compile(),
    );

    await withDeadline("Initialising the Nest testing module", config.adminTimeoutMs, () =>
      moduleRef!.init(),
    );
  });

  afterAll(async () => {
    if (!moduleRef) return;
    // Closing runs `onModuleDestroy`, which disconnects Prisma. Without it the
    // worker keeps a session open and global teardown cannot drop the database.
    await withDeadline("Closing the Nest testing module", config.adminTimeoutMs, () =>
      moduleRef!.close(),
    );
    moduleRef = undefined;
  });

  return handle;
}
