import { Module } from "@nestjs/common";
import { ProofsModule } from "../proofs/proofs.module";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";

// DatabaseModule (@Global) and ConfigModule (isGlobal: true) are already
// available application-wide, so no explicit imports are needed here.
@Module({
  imports: [ProofsModule],
  controllers: [CredentialsController],
  providers: [CredentialsService],
})
export class CredentialsModule {}
