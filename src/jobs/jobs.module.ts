import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { ProofReconciliationService } from "../proofs/proof-reconciliation.service";
import { IssuerReconciliationService } from "../issuers/issuer-reconciliation.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofReconciliationService,
    IssuerReconciliationService,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    ProofReconciliationService,
    IssuerReconciliationService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}