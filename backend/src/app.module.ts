import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AccountsModule } from "./accounts/accounts.module";
import { CategoryCatalogModule } from "./category-catalog/category-catalog.module";
import { ConsentPrivacyModule } from "./consent-privacy/consent-privacy.module";
import { DatabaseModule } from "./database/database.module";
import { GuidanceModule } from "./guidance/guidance.module";
import { PrivacyNoticeModule } from "./privacy-notice/privacy-notice.module";
import { ProfileModule } from "./profile/profile.module";
import { ScanAuditModule } from "./scan-audit/scan-audit.module";
import { ScanResolverModule } from "./scan-resolver/scan-resolver.module";
import { TagLifecycleModule } from "./tag-lifecycle/tag-lifecycle.module";
import { WardGuardiansModule } from "./ward-guardians/ward-guardians.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        if (config.NODE_ENV === "production" && !config.SCAN_LOG_IP_HMAC_SECRET) {
          throw new Error("SCAN_LOG_IP_HMAC_SECRET is required in production");
        }
        return config;
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    AccountsModule,
    WardGuardiansModule,
    CategoryCatalogModule,
    ProfileModule,
    ConsentPrivacyModule,
    TagLifecycleModule,
    ScanResolverModule,
    GuidanceModule,
    ScanAuditModule,
    PrivacyNoticeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
