import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApiKeyService } from "./api-key.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { IntegrationAuthController } from "./integration-auth.controller";

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController, IntegrationAuthController],
  providers: [ApiKeyService, ApiKeyGuard, ScopesGuard],
  exports: [ApiKeyService, ApiKeyGuard, ScopesGuard],
})
export class ApiKeysModule {}
