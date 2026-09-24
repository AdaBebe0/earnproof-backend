import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryService, WebhookSigningService],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
