import { Module } from "@nestjs/common";
import { ProofsModule } from "../proofs/proofs.module";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";
import { CredentialVerificationKeyTrustPinController } from "./credential-verification-key-trust-pin.controller";
import { CredentialVerificationKeyTrustPinService } from "./credential-verification-key-trust-pin.service";

// DatabaseModule (@Global) and ConfigModule (isGlobal: true) are already
// available application-wide, so no explicit imports are needed here.
@Module({
  imports: [ProofsModule],
  controllers: [CredentialsController, CredentialVerificationKeyTrustPinController],
  providers: [CredentialsService, CredentialVerificationKeyTrustPinService],
  exports: [CredentialVerificationKeyTrustPinService],
})
export class CredentialsModule {}
