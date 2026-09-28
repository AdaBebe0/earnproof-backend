import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { ProofsModule } from "../proofs/proofs.module";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { ProofSharingCleanupJob } from "./proof-sharing-cleanup.job";
import { DisclosureCleanupJob } from "./disclosure-cleanup.job";
import { DisclosureModule } from "../common/disclosure/disclosure.module";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  imports: [
    ProofsModule,
    DisclosureModule,
  ],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofSharingCleanupJob,
    DisclosureCleanupJob,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofSharingCleanupJob,
    DisclosureCleanupJob,
    RetentionCleanupService,
  ],
})
export class JobsModule {}