import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { ProofExpirationReconcilerService } from "./proof-expiration-reconciler.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofExpirationReconcilerService,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofExpirationReconcilerService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}