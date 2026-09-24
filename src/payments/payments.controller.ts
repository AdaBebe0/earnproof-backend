import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { ListPaymentsDto } from "./dto/list-payments.dto";
import { UpdatePaymentClassificationDto } from "./dto/update-payment-classification.dto";
import { PaymentsService } from "./payments.service";

@ApiBearerAuth()
@ApiTags("payments")
@UseGuards(AuthGuard)
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("sync")
  @AuthenticatedRoute({ ownership: "user" })
  syncPayments(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.syncPayments(user);
  }

  @Get()
  @AuthenticatedRoute({ ownership: "user" })
  listPayments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPaymentsDto,
  ) {
    return this.paymentsService.listPayments(user.id, query);
  }

  @Get(":id")
  @AuthenticatedRoute({ ownership: "user" })
  getPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") paymentId: string,
  ) {
    return this.paymentsService.getPayment(user.id, paymentId);
  }

  @Patch(":id/classification")
  @AuthenticatedRoute({ ownership: "user" })
  updateClassification(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") paymentId: string,
    @Body() body: UpdatePaymentClassificationDto,
  ) {
    return this.paymentsService.updateClassification(
      user,
      paymentId,
      body.classification,
    );
  }
}
