import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import * as request from "supertest";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import { AppModule } from "../src/app.module";
import { configureApi } from "../src/bootstrap";
import { RedisThrottlerStorage } from "../src/throttler/redis-throttler.storage";
import { DatabaseService } from "../src/database/database.service";
import { createPublicTagCode } from "../src/domain/tag-code";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/safetyspell_integration";

describe("Phase 6 Slice 1: Shared Throttler & Trusted-Proxy IP Resolution", () => {
  let sharedRedisMock: Redis;
  let appInstance1: INestApplication;
  let appInstance2: INestApplication;
  let dbService: DatabaseService;
  let activeTagCode: string;

  beforeAll(async () => {
    // Shared Redis mock for multi-instance simulation
    sharedRedisMock = new RedisMock() as unknown as Redis;

    const createTestApp = async (): Promise<INestApplication> => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ThrottlerStorage)
        .useValue(new RedisThrottlerStorage(sharedRedisMock))
        .compile();

      const app = moduleRef.createNestApplication();
      process.env.TRUST_PROXY_HOPS = "1";
      configureApi(app);
      await app.init();
      return app;
    };

    appInstance1 = await createTestApp();
    appInstance2 = await createTestApp();
    dbService = appInstance1.get(DatabaseService);

    // Seed an active tag with public profile for scanning
    activeTagCode = createPublicTagCode();
    await dbService.query(
      `INSERT INTO tags (
        code, category, category_id, form, inventory_status, holder_kind,
        activation_pin_hash, pin_failed_attempts, activated_at
      ) VALUES ($1, 'elderly', (SELECT id FROM categories WHERE key = 'elderly' LIMIT 1), 'band', 'active', 'company', NULL, 0, NOW())
      ON CONFLICT (code) DO NOTHING`,
      [activeTagCode],
    );
  });

  afterAll(async () => {
    if (appInstance1) await appInstance1.close();
    if (appInstance2) await appInstance2.close();
  });

  beforeEach(async () => {
    await sharedRedisMock.flushall();
  });

  describe("1. Multi-Instance Concurrency & Shared Counter", () => {
    it("enforces shared per-code limit across instances under concurrent burst (Promise.all) and rejects exact straddled excess", async () => {
      const burstSize = 8; // Limit is 5/min per tag code
      const requests: Promise<request.Response>[] = [];

      // Alternate requests concurrently between Instance 1 and Instance 2 from distinct IPs to isolate code limit
      for (let i = 0; i < burstSize; i++) {
        const targetApp = i % 2 === 0 ? appInstance1 : appInstance2;
        requests.push(
          request(targetApp.getHttpServer())
            .get(`/v1/public/scan/${activeTagCode}`)
            .set("X-Forwarded-For", `203.0.113.${100 + i}`),
        );
      }

      const responses = await Promise.all(requests);
      const okCount = responses.filter((r) => r.status === 200).length;
      const throttledCount = responses.filter((r) => r.status === 429).length;

      // Limit for public scan per tag code is 5/min. Exactly 5 must succeed, exactly 3 must be rejected.
      expect(okCount).toBe(5);
      expect(throttledCount).toBe(3);
    });

    it("enforces shared per-IP limit across instances under concurrent burst (Promise.all) and rejects exact straddled excess", async () => {
      const burstSize = 35; // Limit is 30/min per IP
      const requests: Promise<request.Response>[] = [];

      // Alternate requests concurrently between Instance 1 and Instance 2 from same IP to distinct codes
      for (let i = 0; i < burstSize; i++) {
        const targetApp = i % 2 === 0 ? appInstance1 : appInstance2;
        const code = createPublicTagCode();
        requests.push(
          request(targetApp.getHttpServer())
            .get(`/v1/public/scan/${code}`)
            .set("X-Forwarded-For", "203.0.113.50"), // Same client IP
        );
      }

      const responses = await Promise.all(requests);
      const okCount = responses.filter((r) => r.status === 200).length;
      const throttledCount = responses.filter((r) => r.status === 429).length;

      // Limit for public scan per IP is 30/min. Exactly 30 must succeed, exactly 5 must be rejected.
      expect(okCount).toBe(30);
      expect(throttledCount).toBe(5);
    });
  });

  describe("2. Trusted-Proxy Anti-Spoofing & Genuine Client Resolution", () => {
    it("resolves genuine client IP forwarded by Traefik and proves client-prepended forgery cannot shift resolution or poison other budgets", async () => {
      const spoofedAttackerIp = "198.51.100.99";
      const genuineClient1 = "203.0.113.10";
      const genuineClient2 = "203.0.113.20";

      // 1. Client 1 sends 30 requests to distinct codes with forged X-Forwarded-For prepending spoofedAttackerIp
      // Traefik (1 hop) appends genuineClient1 -> "198.51.100.99, 203.0.113.10"
      for (let i = 0; i < 30; i++) {
        const code = createPublicTagCode();
        const res = await request(appInstance1.getHttpServer())
          .get(`/v1/public/scan/${code}`)
          .set("X-Forwarded-For", `${spoofedAttackerIp}, ${genuineClient1}`);
        expect(res.status).toBe(200);
      }

      // 31st request for Client 1 must be throttled (429) on IP budget
      const code31 = createPublicTagCode();
      const throttledRes = await request(appInstance1.getHttpServer())
        .get(`/v1/public/scan/${code31}`)
        .set("X-Forwarded-For", `${spoofedAttackerIp}, ${genuineClient1}`);
      expect(throttledRes.status).toBe(429);

      // 2. Client 2 sends request with SAME forged prefix "198.51.100.99" but genuine IP "203.0.113.20"
      // Traefik appends genuineClient2 -> "198.51.100.99, 203.0.113.20"
      // If spoofedAttackerIp was resolved, it would be 429. Since genuineClient2 is resolved, it MUST succeed (200)!
      const codeClient2 = createPublicTagCode();
      const client2Res = await request(appInstance1.getHttpServer())
        .get(`/v1/public/scan/${codeClient2}`)
        .set("X-Forwarded-For", `${spoofedAttackerIp}, ${genuineClient2}`);
      expect(client2Res.status).toBe(200);
    });
  });

  describe("3. Divergent Outage Policies", () => {
    let brokenApp: INestApplication;

    beforeAll(async () => {
      process.env.TEST_OUTAGE_STRICT = "1";
      // Create an app instance with a broken/unreachable Redis store
      const brokenRedisMock = {
        eval: () => Promise.reject(new Error("Connection to Redis lost (ECONNREFUSED)")),
      };

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ThrottlerStorage)
        .useValue(new RedisThrottlerStorage(brokenRedisMock as unknown as Redis))
        .compile();

      brokenApp = moduleRef.createNestApplication();
      process.env.TRUST_PROXY_HOPS = "1";
      configureApi(brokenApp);
      await brokenApp.init();
    });

    afterAll(async () => {
      delete process.env.TEST_OUTAGE_STRICT;
      if (brokenApp) await brokenApp.close();
    });

    it("PIN claim fails closed (HTTP 429) during Redis outage to protect against unthrottled spraying", async () => {
      const res = await request(brokenApp.getHttpServer())
        .post("/v1/app/wards/00000000-0000-0000-0000-000000000001/tags/claim")
        .send({ tagCode: activeTagCode, pin: "AB34" });

      // PIN claim must hard-fail closed with 429 (throttler guard rejects before auth/controller)
      expect(res.status).toBe(429);
      expect(res.body.message).toContain("Rate limit security store unavailable");
    });

    it("Public emergency scan degrades to tight local limit (fail-bounded, not fail-open) during Redis outage", async () => {
      // Local fallback limit for scanCode is 2 requests per minute
      const code = createPublicTagCode();
      await dbService.query(
        `INSERT INTO tags (
          code, category, category_id, form, inventory_status, holder_kind,
          activation_pin_hash, pin_failed_attempts, activated_at
        ) VALUES ($1, 'elderly', (SELECT id FROM categories WHERE key = 'elderly' LIMIT 1), 'band', 'active', 'company', NULL, 0, NOW())
        ON CONFLICT (code) DO NOTHING`,
        [code],
      );

      // 1st request succeeds via local bounded fallback
      const res1 = await request(brokenApp.getHttpServer())
        .get(`/v1/public/scan/${code}`)
        .set("X-Forwarded-For", "198.51.100.77");
      expect(res1.status).toBe(200);

      // 2nd request succeeds via local bounded fallback
      const res2 = await request(brokenApp.getHttpServer())
        .get(`/v1/public/scan/${code}`)
        .set("X-Forwarded-For", "198.51.100.77");
      expect(res2.status).toBe(200);

      // 3rd request exceeds local fallback limit (2/min for code) -> rejects with 429
      const res3 = await request(brokenApp.getHttpServer())
        .get(`/v1/public/scan/${code}`)
        .set("X-Forwarded-For", "198.51.100.77");
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain("Emergency scan rate limit exceeded (local fallback)");
    });
  });
});
