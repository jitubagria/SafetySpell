import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AccountsModule } from "./accounts/accounts.module";
import { AdminTagsModule } from "./admin-tags/admin-tags.module";
import { ConsentPrivacyModule } from "./consent-privacy/consent-privacy.module";
import { DatabaseModule } from "./database/database.module";
import { InventoryModule } from "./inventory/inventory.module";
import { PrivacyNoticeModule } from "./privacy-notice/privacy-notice.module";
import { ProfileModule } from "./profile/profile.module";
import { ScanAuditModule } from "./scan-audit/scan-audit.module";
import { ScanResolverModule } from "./scan-resolver/scan-resolver.module";
import { TagLifecycleModule } from "./tag-lifecycle/tag-lifecycle.module";
import { TagCustodyModule } from "./tag-custody/tag-custody.module";
import { TagAssignmentModule } from "./tag-assignment/tag-assignment.module";
import { SafetySpellThrottlerModule } from "./throttler/throttler.module";
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
    SafetySpellThrottlerModule,
    DatabaseModule,
    AccountsModule,
    AdminTagsModule,
    WardGuardiansModule,
    ProfileModule,
    ConsentPrivacyModule,
    TagLifecycleModule,
    TagCustodyModule,
    TagAssignmentModule,
    InventoryModule,
    ScanResolverModule,
    ScanAuditModule,
    PrivacyNoticeModule,
  ],
})
export class AppModule {}
