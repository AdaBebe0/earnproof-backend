import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentFinalityService } from "./payment-finality.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [AuthModule, StellarModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentFinalityService],
})
export class PaymentsModule {}
