import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentEligibilityService } from "./payment-eligibility.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [AuthModule, StellarModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentEligibilityService],
  exports: [PaymentEligibilityService],
})
export class PaymentsModule {}
