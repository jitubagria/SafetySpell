import { Module } from "@nestjs/common";
import { ConsentPrivacyModule } from "../consent-privacy/consent-privacy.module";
import { ScanResolverModule } from "../scan-resolver/scan-resolver.module";
import { WardGuardiansService } from "./ward-guardians.service";
import { WardGuardiansController, StaffVerificationController } from "./ward-guardians.controller";

@Module({
  imports: [ConsentPrivacyModule, ScanResolverModule],
  providers: [WardGuardiansService],
  controllers: [WardGuardiansController, StaffVerificationController],
  exports: [WardGuardiansService],
})
export class WardGuardiansModule {}
