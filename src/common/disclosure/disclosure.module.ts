import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../../api-keys/api-keys.module";
import { AuthModule } from "../../auth/auth.module";
import { DatabaseModule } from "../../database/database.module";
import { CredentialVerificationKeyService } from "../crypto/credential-verification-key.service";
import { DisclosureController } from "./disclosure.controller";
import { ReceiptService } from "./receipt.service";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ApiKeysModule,
  ],
  controllers: [DisclosureController],
  providers: [ReceiptService, CredentialVerificationKeyService],
  exports: [ReceiptService],
})
export class DisclosureModule {}