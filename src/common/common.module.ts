import { Module, Global } from "@nestjs/common";
import { IdempotencyService } from "./services/idempotency.service";
import { IdempotentInterceptor } from "./interceptors/idempotent.interceptor";
import { IdempotentOperationController } from "./idempotency/idempotent-operation.controller";
import { ConsistencyTokenService } from "./consistency/consistency-token.service";
import { DomainEventOutboxService } from "./events/domain-event-outbox.service";

/**
 * Global common module providing shared services and interceptors.
 */
@Global()
@Module({
  controllers: [IdempotentOperationController],
  providers: [
    IdempotencyService,
    IdempotentInterceptor,
    ConsistencyTokenService,
    DomainEventOutboxService,
  ],
  exports: [
    IdempotencyService,
    IdempotentInterceptor,
    ConsistencyTokenService,
    DomainEventOutboxService,
  ],
})
export class CommonModule {}
