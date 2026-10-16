import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { ApprovalExpiryJob } from "./approval-expiry.job";
import { WebhookCertificateExpiryJob } from "./webhook-certificate-expiry.job";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  imports: [ApprovalsModule, WebhooksModule],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    RetentionJob,
    ApprovalExpiryJob,
    WebhookCertificateExpiryJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}
