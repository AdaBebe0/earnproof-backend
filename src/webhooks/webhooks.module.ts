import { QuotasModule } from "../quotas/quotas.module";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";
import { WebhookClientCertificatesController } from "./webhook-client-certificates.controller";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController, WebhookClientCertificatesController],
  imports: [AuthModule, QuotasModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDeliveryService,
    WebhookSigningService,
    WebhookClientCertificateService,
  ],
  exports: [WebhookDeliveryService, WebhookClientCertificateService],
    WebhookCircuitBreakerService,
  ],
  exports: [WebhookDeliveryService, WebhookCircuitBreakerService],
})
export class WebhooksModule {}
