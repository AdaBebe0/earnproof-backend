import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthTokenService } from "./auth-token.service";
import { SessionService } from "./session.service";
import { AuthGuard } from "../common/guards/auth.guard";
import { CleanupJob } from "./cleanup.job";
import { AuthAuditService } from "./auth-audit.service";
import { AuthRateLimiterService } from "./auth-rate-limiter.service";
import { Clock, SystemClock } from "../common/time/clock";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthTokenService,
    SessionService,
    AuthAuditService,
    AuthRateLimiterService,
    AuthGuard,
    CleanupJob,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [SessionService, AuthTokenService, AuthGuard, AuthAuditService],
})
export class AuthModule {}
