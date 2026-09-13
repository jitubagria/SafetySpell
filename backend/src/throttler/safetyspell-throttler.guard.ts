import { ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { ThrottlerException, ThrottlerGuard } from "@nestjs/throttler";
import { ThrottlerRequest } from "@nestjs/throttler/dist/throttler.guard.interface";

interface LocalWindowRecord {
  timestamps: number[];
}

@Injectable()
export class SafetySpellThrottlerGuard extends ThrottlerGuard {
  private readonly fallbackLogger = new Logger(SafetySpellThrottlerGuard.name);
  private readonly localFallbackStore = new Map<string, LocalWindowRecord>();

  private enforceLocalFallback(
    key: string,
    limit: number,
    ttlMs: number,
  ): boolean {
    const now = Date.now();
    const clearBefore = now - ttlMs;
    let record = this.localFallbackStore.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.localFallbackStore.set(key, record);
    }
    // Evict old hits
    record.timestamps = record.timestamps.filter((ts) => ts > clearBefore);

    if (record.timestamps.length >= limit) {
      return false; // over local limit
    }
    record.timestamps.push(now);
    return true; // allowed
  }

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration, getTracker, generateKey } =
      requestProps;
    const { req } = this.getRequestResponse(context);
    const path: string = req.path ?? req.url ?? "";
    const isPublicScan = path.startsWith("/v1/public/scan/");
    const isClaimEndpoint =
      path.includes("/tags/claim") || path.endsWith("/claim");

    const tracker = getTracker
      ? await getTracker(req, context)
      : await this.getTracker(req);
    const throttlerName = throttler.name ?? "default";
    const key = generateKey
      ? generateKey(context, tracker, throttlerName)
      : this.generateKey(context, tracker, throttlerName);

    try {
      const record = await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );

      if (record.isBlocked) {
        await this.throwThrottlingException(context, {
          limit,
          ttl,
          key,
          tracker,
          totalHits: record.totalHits,
          timeToExpire: record.timeToExpire,
          isBlocked: record.isBlocked,
          timeToBlockExpire: record.timeToBlockExpire,
        });
      }
      return true;
    } catch (storageError: any) {
      // Re-throw genuine ThrottlerException (rate limit exceeded)
      if (storageError instanceof ThrottlerException) {
        throw storageError;
      }

      // Storage failure path (e.g. Redis unreachable or network partition)
      if (isClaimEndpoint) {
        this.fallbackLogger.error(
          `Redis outage on PIN claim path [${key}]. Hard fail-closed: 429`,
        );
        throw new ThrottlerException(
          "Rate limit security store unavailable: request rejected",
        );
      }

      if (isPublicScan) {
        this.fallbackLogger.warn(
          `Redis outage on public scan path [${key}]. Degrading to tight local limit (fail-bounded).`,
        );
        // Strict emergency local fallback limits:
        // scanCode throttler -> 2 per minute
        // default IP throttler -> 10 per minute
        const localLimit = throttlerName === "scanCode" ? 2 : 10;
        const localTtl = 60_000;
        const localKey = `fallback:${throttlerName}:${tracker}`;

        const isAllowed = this.enforceLocalFallback(
          localKey,
          localLimit,
          localTtl,
        );
        if (!isAllowed) {
          throw new ThrottlerException(
            "Emergency scan rate limit exceeded (local fallback)",
          );
        }
        return true;
      }

      // Default non-critical routes fail-closed
      this.fallbackLogger.error(
        `Redis outage on route [${path}]. Fail-closed: 429`,
      );
      throw new ThrottlerException(
        "Rate limit security store unavailable: request rejected",
      );
    }
  }
}
