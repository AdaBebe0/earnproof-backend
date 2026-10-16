import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { DistributedLeaseService } from "./distributed-lease.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    DistributedLeaseService,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    DistributedLeaseService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}
