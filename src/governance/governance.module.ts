import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { GovernanceController } from "./governance.controller";
import { GovernanceService } from "./governance.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
