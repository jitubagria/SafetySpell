import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AccountsModule } from "./accounts/accounts.module";
import { AdminTagsModule } from "./admin-tags/admin-tags.module";
import { ConsentPrivacyModule } from "./consent-privacy/consent-privacy.module";
import { DatabaseModule } from "./database/database.module";
import { PrivacyNoticeModule } from "./privacy-notice/privacy-notice.module";
import { ProfileModule } from "./profile/profile.module";
import { ScanAuditModule } from "./scan-audit/scan-audit.module";
import { ScanResolverModule } from "./scan-resolver/scan-resolver.module";
import { TagLifecycleModule } from "./tag-lifecycle/tag-lifecycle.module";
import { TagCustodyModule } from "./tag-custody/tag-custody.module";
import { WardGuardiansModule } from "./ward-guardians/ward-guardians.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // In tests the database URL is supplied via the environment (an isolated test DB).
      // Ignore any local .env so a developer's server .env cannot hijack the test database.
      ignoreEnvFile: process.env.NODE_ENV === "test",
      validate: (config) => {
        if (config.NODE_ENV === "production" && !config.SCAN_LOG_IP_HMAC_SECRET) {
          throw new Error("SCAN_LOG_IP_HMAC_SECRET is required in production");
        }
        return config;
      },
    }),
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 100 },
      {
        name: "scanCode",
        ttl: 60_000,
        limit: 5,
        // The public route also retains its stricter per-IP bucket. This bucket
        // intentionally groups all source IPs by the normalized public code.
        getTracker: (request) =>
          String(request.params?.tagCode ?? "")
            .trim()
            .toUpperCase(),
        skipIf: (context) => {
          const request = context.switchToHttp().getRequest<{ path?: string }>();
          return !request.path?.startsWith("/v1/public/scan/");
        },
      },
    ]),
    DatabaseModule,
    AccountsModule,
    AdminTagsModule,
    WardGuardiansModule,
    ProfileModule,
    ConsentPrivacyModule,
    TagLifecycleModule,
    TagCustodyModule,
    ScanResolverModule,
    ScanAuditModule,
    PrivacyNoticeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
