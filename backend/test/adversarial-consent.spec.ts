import { ForbiddenException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../src/common/request-user";
import { ConsentPrivacyService } from "../src/consent-privacy/consent-privacy.service";
import { RescueRepository } from "../src/domain/rescue.repository";
import { ScanLogIpHasher, hmacScanIp } from "../src/scan-resolver/scan-log-ip-hasher";
import { ScanResolverService } from "../src/scan-resolver/scan-resolver.service";
import { WardGuardiansController } from "../src/ward-guardians/ward-guardians.controller";
import { WardGuardiansService } from "../src/ward-guardians/ward-guardians.service";

const baseRepository = (): jest.Mocked<RescueRepository> => ({
  findActiveTag: jest.fn(),
  getFilteredPublicProjection: jest.fn(),
  getPublishedGuidance: jest.fn(),
  writeScanLog: jest.fn(),
  listAuthorizedWards: jest.fn(),
  getAuthorizedWard: jest.fn(),
  listAuthorizedWardTags: jest.fn(),
  getAuthorizedFields: jest.fn(),
  assertGuardianPermission: jest.fn(),
  getCatalogField: jest.fn(),
  upsertGuardianValue: jest.fn(),
  setVisibility: jest.fn(),
  withdrawPublicRelease: jest.fn(),
  getLatestPrivacyNotice: jest.fn(),
  getConsentAudit: jest.fn(),
  transaction: jest.fn(),
});

const hashIp = (secret = "test-hmac-secret") =>
  ({ hash: (ip?: string) => hmacScanIp(ip, secret) }) as ScanLogIpHasher;

const roleContext = (
  role: "company_admin" | "guardian" | "staff",
  controller: object,
  handler: object,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: "user-1", role } }) }),
  }) as unknown as ExecutionContext;

describe("Rescue ID V1 adversarial consent boundary", () => {
  it("returns only consent-filtered fields and never invokes a raw profile path", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({ id: "tag-1", wardId: "ward-1", category: "medical" });
    // The deliberately private address is absent from the projection before ScanResolver sees it.
    repo.getFilteredPublicProjection.mockResolvedValue({
      category: "medical",
      policyVersion: 2,
      fields: [
        {
          key: "blood_group",
          label: "Blood group",
          value: "O+",
          provenance: "guardian_reported",
          catalogVersion: 2,
        },
      ],
    });
    repo.getPublishedGuidance.mockResolvedValue([]);
    const response = await new ScanResolverService(repo, hashIp()).resolve(
      "SS-opaque-code-1234",
      "203.0.113.7",
    );
    expect(response).toEqual(
      expect.objectContaining({
        status: "available",
        fields: [expect.objectContaining({ key: "blood_group" })],
      }),
    );
    expect(JSON.stringify(response)).not.toContain("address");
    expect(JSON.stringify(response)).not.toContain("medication");
    expect(repo.writeScanLog).toHaveBeenCalledWith(
      expect.objectContaining({ shownFieldKeys: ["blood_group"] }),
    );
  });

  it("returns the same neutral response for an inactive, lost, revoked, or unknown tag", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue(null);
    const response = await new ScanResolverService(repo, hashIp()).resolve("a-guess");
    expect(response).toEqual({ status: "tag_unavailable" });
    expect(repo.getFilteredPublicProjection).not.toHaveBeenCalled();
    expect(repo.writeScanLog).not.toHaveBeenCalled();
  });

  it("blocks an unapproved catalog field from public release", async () => {
    const repo = baseRepository();
    repo.getAuthorizedWard.mockResolvedValue({
      id: "ward-1",
      category: "medical",
      name: "Private",
      status: "active",
    });
    repo.getCatalogField.mockResolvedValue({
      id: "catalog-1",
      category: "medical",
      key: "allergy",
      approved: false,
      publicEligible: false,
      maxLevel: "private",
      dataType: "short_text",
      validationPolicy: { max_length: 64 },
    });
    const service = new ConsentPrivacyService(repo);
    await expect(
      service.setVisibility({
        actorId: "guardian-1",
        wardId: "ward-1",
        catalogId: "catalog-1",
        visibility: "public",
        sessionMetadata: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.setVisibility).not.toHaveBeenCalled();
  });

  it("rejects the reserved responder level in every V1 consent write", async () => {
    const repo = baseRepository();
    const service = new ConsentPrivacyService(repo);
    await expect(
      service.setVisibility({
        actorId: "guardian-1",
        wardId: "ward-1",
        catalogId: "catalog-1",
        visibility: "verified_emergency_responder" as never,
        sessionMetadata: {},
      }),
    ).rejects.toThrow("V1 only permits private or public");
    expect(repo.assertGuardianPermission).not.toHaveBeenCalled();
  });

  it("blocks a guardian without active release authority", async () => {
    const repo = baseRepository();
    repo.assertGuardianPermission.mockRejectedValue(
      new ForbiddenException("Guardian is not authorised"),
    );
    const service = new ConsentPrivacyService(repo);
    await expect(
      service.setVisibility({
        actorId: "guardian-2",
        wardId: "ward-1",
        catalogId: "catalog-1",
        visibility: "private",
        sessionMetadata: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.setVisibility).not.toHaveBeenCalled();
  });

  it("withdraws a ward public release atomically through the repository and exposes no action-handle API", async () => {
    const repo = baseRepository();
    const service = new ConsentPrivacyService(repo);
    await service.withdrawPublicRelease({
      actorId: "guardian-1",
      wardId: "ward-1",
      sessionMetadata: { source: "test" },
    });
    expect(repo.withdrawPublicRelease).toHaveBeenCalledWith(
      expect.objectContaining({ wardId: "ward-1" }),
    );
    // RescueRepository intentionally has no create/resolve action-handle method in V1.
    expect("resolveActionHandle" in repo).toBe(false);
  });

  it("blocks staff from guardian routes even though those roles live on the controller class", () => {
    const guard = new RolesGuard(new Reflector());
    expect(() =>
      guard.canActivate(
        roleContext("staff", WardGuardiansController, WardGuardiansController.prototype.list),
      ),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(
        roleContext("guardian", WardGuardiansController, WardGuardiansController.prototype.list),
      ),
    ).toBe(true);
  });

  it("uses keyed HMAC for scan-log IP pseudonyms and omits them safely without a secret", () => {
    const first = hmacScanIp("203.0.113.7", "secret-one");
    const second = hmacScanIp("203.0.113.7", "secret-two");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("203.0.113.7");
    expect(hmacScanIp("203.0.113.7", undefined)).toBeUndefined();
  });

  it("rejects an out-of-policy value routed through a controlled public enum field", async () => {
    const repo = baseRepository();
    repo.getAuthorizedWard.mockResolvedValue({
      id: "ward-1",
      category: "medical",
      name: "Private",
      status: "active",
    });
    repo.getCatalogField.mockResolvedValue({
      id: "catalog-1",
      category: "medical",
      key: "blood_group",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "enum",
      validationPolicy: { allowed_values: ["A+", "O+"] },
    });
    const service = new WardGuardiansService(repo);
    await expect(
      service.writeGuardianValue({
        userId: "guardian-1",
        wardId: "ward-1",
        catalogId: "catalog-1",
        value: "12 Example Road, medication history enclosed",
      }),
    ).rejects.toThrow("Value is not allowed by the catalog policy");
    expect(repo.upsertGuardianValue).not.toHaveBeenCalled();
  });

  it("refuses public release for a free-text field with no length bound", async () => {
    const repo = baseRepository();
    repo.getAuthorizedWard.mockResolvedValue({
      id: "ward-1",
      category: "medical",
      name: "Private",
      status: "active",
    });
    // Public free text is admissible ONLY when bounded. Without a numeric max_length the
    // consent gate must still refuse release even if the row otherwise claims it is public.
    repo.getCatalogField.mockResolvedValue({
      id: "catalog-1",
      category: "medical",
      key: "allergy",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "text",
      validationPolicy: {},
    });
    await expect(
      new ConsentPrivacyService(repo).setVisibility({
        actorId: "guardian-1",
        wardId: "ward-1",
        catalogId: "catalog-1",
        visibility: "public",
        sessionMetadata: {},
      }),
    ).rejects.toThrow("public-release catalog gates");
    expect(repo.setVisibility).not.toHaveBeenCalled();
  });

  it("sanitises hostile free-text before storage: strips HTML and neutralises links", async () => {
    const repo = baseRepository();
    repo.getAuthorizedWard.mockResolvedValue({
      id: "ward-1",
      category: "medical",
      name: "Private",
      status: "active",
    });
    repo.getCatalogField.mockResolvedValue({
      id: "catalog-1",
      category: "medical",
      key: "allergy",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "text",
      validationPolicy: { max_length: 1000 },
    });
    const service = new WardGuardiansService(repo);
    await service.writeGuardianValue({
      userId: "guardian-1",
      wardId: "ward-1",
      catalogId: "catalog-1",
      value:
        'Penicillin <script>alert(1)</script>\nvisit http://evil.test and www.bad.test\n<a href="javascript:steal()">Peanuts</a>',
    });
    const stored = repo.upsertGuardianValue.mock.calls[0]![0].value as string;
    expect(typeof stored).toBe("string");
    expect(stored).not.toMatch(/<[^>]*>/); // no HTML tags
    expect(stored).not.toMatch(/https?:\/\//i); // no clickable url scheme
    expect(stored).not.toMatch(/javascript:/i); // no script scheme
    expect(stored).toContain("Penicillin");
    expect(stored).toContain("Peanuts");
  });
});
