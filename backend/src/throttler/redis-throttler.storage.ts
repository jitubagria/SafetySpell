import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import Redis, { RedisOptions } from "ioredis";

export const REDIS_THROTTLER_PREFIX = "safetyspell:rl:";
export const REDIS_CLIENT_TOKEN = "REDIS_CLIENT_TOKEN";

const LUA_SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - ttl

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentHits = redis.call('ZCARD', key)

if currentHits < limit then
  local seq = redis.call('INCR', key .. ':seq')
  redis.call('ZADD', key, now, now .. ':' .. seq)
  redis.call('PEXPIRE', key, ttl)
  redis.call('PEXPIRE', key .. ':seq', ttl)
  return { currentHits + 1, ttl, 0 }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local timeToExpire = ttl
  if oldest and #oldest >= 2 then
    timeToExpire = math.max(0, math.floor(tonumber(oldest[2]) + ttl - now))
  end
  redis.call('PEXPIRE', key, ttl)
  return { currentHits + 1, timeToExpire, 1 }
end
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redisClient: Redis;
  private isConnected = false;

  constructor(@Optional() @Inject(REDIS_CLIENT_TOKEN) redisUrlOrClient?: string | Redis) {
    if (typeof redisUrlOrClient === "object" && redisUrlOrClient !== null) {
      this.redisClient = redisUrlOrClient;
      this.isConnected = true;
    } else {
      const url =
        typeof redisUrlOrClient === "string"
          ? redisUrlOrClient
          : (process.env.REDIS_URL ?? "redis://localhost:6379");
      const options: RedisOptions = {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 100, 2000),
      };
      if (process.env.REDIS_PASSWORD) {
        options.password = process.env.REDIS_PASSWORD;
      }
      this.redisClient = new Redis(url, options);

      this.redisClient.on("connect", () => {
        this.isConnected = true;
        this.logger.log("Connected to Redis throttler store");
      });

      this.redisClient.on("error", (err) => {
        this.isConnected = false;
        this.logger.warn(`Redis throttler error: ${err.message}`);
      });
    }
  }

  public get isStoreConnected(): boolean {
    return this.isConnected;
  }

  public async onModuleDestroy(): Promise<void> {
    try {
      if (this.redisClient.status !== "end") {
        await this.redisClient.quit();
      }
    } catch {
      // Ignore disconnect errors on shutdown
    }
  }

  public async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const namespacedKey = `${REDIS_THROTTLER_PREFIX}${key}`;
    const now = Date.now();

    try {
      const result = (await this.redisClient.eval(
        LUA_SLIDING_WINDOW_SCRIPT,
        1,
        namespacedKey,
        now,
        ttl,
        limit,
      )) as [number, number, number];

      const [totalHits, timeToExpire, isBlockedNum] = result;
      const isBlocked = isBlockedNum === 1 || totalHits > limit;

      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: timeToExpire,
      };
    } catch (err: unknown) {
      this.isConnected = false;
      const message = err instanceof Error ? err.message : "Unknown Redis error";
      this.logger.error(`Redis increment failed for ${namespacedKey}: ${message}`);
      throw err;
    }
  }
}
