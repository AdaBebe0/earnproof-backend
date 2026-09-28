import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { AttestationsService } from "./attestations.service";
import { IssuersService } from "./issuers.service";
import { IssuersController } from "./issuers.controller";
import { IssuerRegistryService } from "./issuer-registry.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [IssuersController],
  providers: [IssuerRegistryService, IssuersService, AttestationsService],
  exports: [IssuersService, AttestationsService],
})
export class IssuersModule {}
