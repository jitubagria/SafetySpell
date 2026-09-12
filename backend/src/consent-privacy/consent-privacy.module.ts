import { Module } from "@nestjs/common";
import { ScanResolverModule } from "../scan-resolver/scan-resolver.module";
import { ConsentPrivacyService } from "./consent-privacy.service";
import { ConsentPrivacyController } from "./consent-privacy.controller";

@Module({
  imports: [ScanResolverModule],
  providers: [ConsentPrivacyService],
  controllers: [ConsentPrivacyController],
  exports: [ConsentPrivacyService],
})
export class ConsentPrivacyModule {}
