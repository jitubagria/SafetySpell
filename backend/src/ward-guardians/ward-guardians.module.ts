import { Module } from "@nestjs/common";
import { ScanResolverModule } from "../scan-resolver/scan-resolver.module";
import { WardGuardiansService } from "./ward-guardians.service";
import { WardGuardiansController, StaffVerificationController } from "./ward-guardians.controller";

@Module({
  imports: [ScanResolverModule],
  providers: [WardGuardiansService],
  controllers: [WardGuardiansController, StaffVerificationController],
  exports: [WardGuardiansService],
})
export class WardGuardiansModule {}
