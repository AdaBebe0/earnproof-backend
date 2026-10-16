import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PaymentEncryptionRewrapService } from "./encryption/payment-encryption-rewrap.service";
import { PaymentEncryptionRetirementService } from "./encryption/payment-encryption-retirement.service";
import { EncryptionKeyRewrapWorkerService } from "./encryption/encryption-key-rewrap-worker.service";
import { EncryptionKeyRetirementWorkerService } from "./encryption/encryption-key-retirement-worker.service";

@Module({
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    RetentionJob,
    PaymentEncryptionKeyringService,
    PaymentEncryptionRewrapService,
    PaymentEncryptionRetirementService,
    EncryptionKeyRewrapWorkerService,
    EncryptionKeyRetirementWorkerService,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    PaymentEncryptionRewrapService,
    PaymentEncryptionRetirementService,
  ],
})
export class JobsModule {}