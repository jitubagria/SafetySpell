import { Module } from "@nestjs/common";
import { ScanResolverModule } from "../scan-resolver/scan-resolver.module";
import { PrivacyNoticeController } from "./privacy-notice.controller";
@Module({ imports: [ScanResolverModule], controllers: [PrivacyNoticeController] })
export class PrivacyNoticeModule {}
