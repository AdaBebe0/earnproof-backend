import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { QuotasModule } from "../quotas/quotas.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentClassificationHistoryService } from "./payment-classification-history.service";
import { PaymentCheckpointHealthService } from "./payment-checkpoint-health.service";
import { PaymentEligibilityService } from "./payment-eligibility.service";
import { PaymentFinalityService } from "./payment-finality.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [AuthModule, StellarModule, QuotasModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentFinalityService,
    PaymentEligibilityService,
    PaymentClassificationHistoryService,
    PaymentCheckpointHealthService,
  ],
  exports: [
    PaymentsService,
    PaymentFinalityService,
    PaymentEligibilityService,
    PaymentClassificationHistoryService,
    PaymentCheckpointHealthService,
  ],
})
export class PaymentsModule {}
