import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";
import { WebhookClientCertificatesController } from "./webhook-client-certificates.controller";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController, WebhookClientCertificatesController],
  providers: [
    WebhooksService,
    WebhookDeliveryService,
    WebhookSigningService,
    WebhookClientCertificateService,
  ],
  exports: [WebhookDeliveryService, WebhookClientCertificateService],
})
export class WebhooksModule {}
