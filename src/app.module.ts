import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { configuration } from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { PaymentsModule } from "./payments/payments.module";
import { ProofsModule } from "./proofs/proofs.module";
import { AuthorizationPolicyRegistry } from "./common/guards/authorization-policy.registry";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    DiscoveryModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    PaymentsModule,
    ProofsModule,
  ],
  providers: [AuthorizationPolicyRegistry],
})
export class AppModule {}
