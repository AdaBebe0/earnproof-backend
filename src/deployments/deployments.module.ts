import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MaintenanceDrainService } from "./maintenance-drain.service";
import { MaintenanceDrainController } from "./maintenance-drain.controller";

@Module({
  imports: [AuthModule],
  controllers: [MaintenanceDrainController],
  providers: [MaintenanceDrainService],
  exports: [MaintenanceDrainService],
})
export class DeploymentsModule {}
