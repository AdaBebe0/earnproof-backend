import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AttestationsModule } from "../attestations/attestations.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";
import { ProofVerificationAbuseService } from "../common/rate-limit/proof-verification-abuse.service";

@Module({
  imports: [AuthModule, AuditModule, AttestationsModule, WebhooksModule],
  controllers: [ProofsController],
  providers: [ContractAnchoringService, ProofsService, ProofVerificationAbuseService],
  exports: [ContractAnchoringService],
})
export class ProofsModule {}
