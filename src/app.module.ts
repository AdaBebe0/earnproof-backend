import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuthModule } from "./auth/auth.module";
import { configuration } from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { CredentialsModule } from "./credentials/credentials.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { HttpMetricsInterceptor } from "./common/interceptors/http-metrics.interceptor";
import { ObservabilityModule } from "./common/observability/observability.module";
import { JobsModule } from "./jobs/jobs.module";
import { IssuersModule } from "./issuers/issuers.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { DataResidencyModule } from "./organizations/residency/data-residency.module";
import { PaymentsModule } from "./payments/payments.module";
import { ProofsModule } from "./proofs/proofs.module";
import { SchemaImportsModule } from "./schemas/schema-imports.module";
import { TrustedSourcesModule } from "./trusted-sources/trusted-sources.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60_000, // 1 minute in milliseconds
        limit: 1000, // generous default; per-route overrides tighten this
      },
    ]),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    AuditModule,
    ApiKeysModule,
    ApprovalsModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    DataResidencyModule,
    IssuersModule,
    PaymentsModule,
    ProofsModule,
    CredentialsModule,
    SchemaImportsModule,
    TrustedSourcesModule,
    JobsModule,
    WebhooksModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
  ],
})
export class AppModule {}
