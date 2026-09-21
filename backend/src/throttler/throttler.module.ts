import { ExecutionContext, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import { REDIS_CLIENT_TOKEN, RedisThrottlerStorage } from "./redis-throttler.storage";
import { SafetySpellThrottlerGuard } from "./safetyspell-throttler.guard";
import { isPublicScanKillEnabled } from "../scan-resolver/scan-kill-switch";

function isPublicScanRequest(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<{ path?: string }>();
  return request.path?.startsWith("/v1/public/scan/") ?? false;
}

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
          {
            name: "default",
            ttl: 60_000,
            limit: defaultLimit,
            // Dark mode must always return the resolver's neutral 200 response,
            // rather than a rate-limit response that varies by recent traffic.
            skipIf: (context) => isPublicScanKillEnabled() && isPublicScanRequest(context),
          },
          {
            name: "scanCode",
            ttl: 60_000,
            limit: scanCodeLimit,
            getTracker: scanCodeTracker,
            skipIf: (context) => {
              return isPublicScanKillEnabled() || !isPublicScanRequest(context);
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
    // Kept injectable so database integration tests can use the approved shared
    // Redis mock without changing runtime Redis selection.
    {
      provide: REDIS_CLIENT_TOKEN,
      useFactory: () => process.env.REDIS_URL,
    },
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
