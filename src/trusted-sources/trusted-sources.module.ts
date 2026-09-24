import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TrustedSourcesController } from "./trusted-sources.controller";
import { TrustedSourcesService } from "./trusted-sources.service";

@Module({
  imports: [AuthModule],
  controllers: [TrustedSourcesController],
  providers: [TrustedSourcesService],
  exports: [TrustedSourcesService],
})
export class TrustedSourcesModule {}
