import { Module } from "@nestjs/common";
import { VerificationEventService } from "./verification-event.service";

@Module({
  providers: [VerificationEventService],
  exports: [VerificationEventService],
})
export class AuditModule {}
