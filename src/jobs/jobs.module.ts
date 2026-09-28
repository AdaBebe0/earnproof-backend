import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { AttestationReconcilerService } from "./attestation-reconciler.service";
import { JobExecutionController } from "./execution/job-execution.controller";
import { JobExecutionMaintenanceJob } from "./execution/job-execution-maintenance.job";
import { JobExecutionService } from "./execution/job-execution.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

/**
 * ApiKeysModule is imported for the ApiKeyGuard and ScopesGuard that protect the
 * operator execution-history endpoint, reusing the existing authorization path
 * rather than inventing a second one — the same choice HealthModule makes.
 */
@Module({
  imports: [WebhooksModule],
  imports: [ApiKeysModule],
  controllers: [JobExecutionController],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    AttestationReconcilerService,
    RetentionCleanupService,
    RetentionJob,
    JobExecutionService,
    JobExecutionMaintenanceJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    AttestationReconcilerService,
    RetentionCleanupService,
    JobExecutionService,
  ],
})
export class JobsModule {}
