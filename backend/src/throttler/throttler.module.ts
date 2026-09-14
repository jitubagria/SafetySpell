import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import { RedisThrottlerStorage } from "./redis-throttler.storage";
import { SafetySpellThrottlerGuard } from "./safetyspell-throttler.guard";

function scanCodeTracker(request: Record<string, unknown>): string {
  const params = request.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "";
  const tagCode = (params as Record<string, unknown>).tagCode;
  return typeof tagCode === "string" ? tagCode.trim().toUpperCase() : "";
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const defaultLimit = config.get<number>("DEFAULT_THROTTLE_LIMIT") ?? 100;
        const scanCodeLimit = config.get<number>("SCAN_CODE_THROTTLE_LIMIT") ?? 5;
        const claimLimit =
          config.get<number>("CLAIM_THROTTLE_LIMIT") ??
          (process.env.NODE_ENV === "test" ? 100 : 10);

        return [
          { name: "default", ttl: 60_000, limit: defaultLimit },
          {
            name: "scanCode",
            ttl: 60_000,
            limit: scanCodeLimit,
            getTracker: scanCodeTracker,
            skipIf: (context) => {
              const request = context.switchToHttp().getRequest<{ path?: string }>();
              return !request.path?.startsWith("/v1/public/scan/");
            },
          },
          {
            name: "claimIp",
            ttl: 60_000,
            limit: claimLimit,
            skipIf: (context) => {
              const request = context
                .switchToHttp()
                .getRequest<{ path?: string; method?: string }>();
              const path = request.path ?? "";
              return !(path.includes("/tags/claim") || path.endsWith("/claim"));
            },
          },
        ];
      },
    }),
  ],
  providers: [
    {
      provide: ThrottlerStorage,
      useClass: RedisThrottlerStorage,
    },
    {
      provide: APP_GUARD,
      useClass: SafetySpellThrottlerGuard,
    },
  ],
  exports: [ThrottlerStorage],
})
export class SafetySpellThrottlerModule {}
