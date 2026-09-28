import { QuotasModule } from "../quotas/quotas.module";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";
import {
  ProofShareTokensController,
  ProofSharesController,
} from "./share-tokens/proof-share-tokens.controller";
import { ProofShareTokensService } from "./share-tokens/proof-share-tokens.service";

@Module({
  imports: [AuthModule, AuditModule, WebhooksModule, QuotasModule],
  controllers: [
    ProofShareTokensController,
    ProofSharesController,
    ProofsController,
  ],
  providers: [ContractAnchoringService, ProofsService, ProofShareTokensService],
  exports: [ContractAnchoringService],
})
export class ProofsModule {}
