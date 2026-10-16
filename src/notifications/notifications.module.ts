import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityNotificationsController } from "./security-notifications.controller";
import { SecurityNotificationService } from "./security-notification.service";

@Module({
  imports: [AuthModule],
  controllers: [SecurityNotificationsController],
  providers: [SecurityNotificationService],
  exports: [SecurityNotificationService],
})
export class NotificationsModule {}
