import { Module } from "@nestjs/common";
import { AuditAdminController } from "./audit-admin.controller";
import { AuditAdminService } from "./audit-admin.service";
import { AuditVerificationService } from "./audit-verification.service";
import { VerificationEventService } from "./verification-event.service";
import { SecretRetrievalReceiptService } from "./secret-retrieval-receipt.service";

import { AuditGraphService } from "./audit-graph.service";

@Module({
  controllers: [AuditAdminController],
  providers: [
    VerificationEventService,
    AuditAdminService,
    AuditVerificationService,
    AuditGraphService,
  ],
  exports: [VerificationEventService, AuditVerificationService, AuditGraphService],
})
export class AuditModule {}
