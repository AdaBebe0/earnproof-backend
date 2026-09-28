import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { QuotasModule } from "../quotas/quotas.module";
import { OrganizationsService } from "./organizations.service";
import { OrganizationsController } from "./organizations.controller";

@Module({
  imports: [DatabaseModule, AuthModule, QuotasModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
