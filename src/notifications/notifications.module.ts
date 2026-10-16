import { Module } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { AuthModule } from "../auth/auth.module";
import { SecurityNotificationsController } from "./security-notifications.controller";
import { SecurityNotificationService } from "./security-notification.service";

@Module({
  imports: [AuthModule],
  controllers: [SecurityNotificationsController],
  providers: [NotificationsService, SecurityNotificationService],
  exports: [NotificationsService, SecurityNotificationService],
})
export class NotificationsModule {}
