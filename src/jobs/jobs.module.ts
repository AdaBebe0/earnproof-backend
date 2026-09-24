import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}