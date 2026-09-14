import * as jwt from "jsonwebtoken";
import { UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard, RequestWithUser } from "../src/common/request-user";

const secret = "tenant-guard-test-secret-at-least-32-characters";

function context(request: RequestWithUser) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe("tenant-bound JWT guard", () => {
  it("uses the signed tenant validated against the live user, never a client tenant header", async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValue({ rows: [{ id: "user-a", role: "guardian", tenant_id: "tenant-a" }] }),
    };
    const guard = new JwtAuthGuard({ getOrThrow: () => secret } as never, db as never);
    const token = jwt.sign({ sub: "user-a", role: "guardian", tenantId: "tenant-a" }, secret);
    const request: RequestWithUser = {
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": "tenant-b" },
    };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: "user-a", role: "guardian", tenantId: "tenant-a" });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("tenant_id = $2"), [
      "user-a",
      "tenant-a",
    ]);
  });

  it("rejects a token whose tenant no longer matches the live user record", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const guard = new JwtAuthGuard({ getOrThrow: () => secret } as never, db as never);
    const token = jwt.sign({ sub: "user-a", role: "guardian", tenantId: "tenant-a" }, secret);

    await expect(
      guard.canActivate(context({ headers: { authorization: `Bearer ${token}` } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
