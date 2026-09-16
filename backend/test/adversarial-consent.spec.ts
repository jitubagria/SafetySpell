import { ForbiddenException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../src/common/request-user";
import { ConsentPrivacyService } from "../src/consent-privacy/consent-privacy.service";
import { createPublicTagCode } from "../src/domain/tag-code";
import { RescueRepository } from "../src/domain/rescue.repository";
import { ScanLogIpHasher, hmacScanIp } from "../src/scan-resolver/scan-log-ip-hasher";
import { ScanResolverService } from "../src/scan-resolver/scan-resolver.service";
import { WardGuardiansController } from "../src/ward-guardians/ward-guardians.controller";
import { WardGuardiansService } from "../src/ward-guardians/ward-guardians.service";

const baseRepository = (): jest.Mocked<RescueRepository> => ({
  findActiveTag: jest.fn(),
  getFilteredPublicProjection: jest.fn(),
  getAssetPublicProjection: jest.fn(),
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
    repo.findActiveTag.mockResolvedValue({
      id: "tag-1",
      tenantId: "tenant-1",
      wardId: "ward-1",
      category: "medical",
      categoryKind: "consent_governed_person",
    });
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

  it("branches to the separate asset allowlist only for a tag whose server-owned category is plain_asset", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({
      id: "asset-tag-1",
      tenantId: "tenant-1",
      assetId: "asset-1",
      category: "asset",
      categoryKind: "plain_asset",
    });
    repo.getAssetPublicProjection.mockResolvedValue({
      category: "asset",
      policyVersion: 1,
      fields: [
        {
          key: "label",
          label: "Label",
          value: "Cylinder C-42",
          provenance: "tenant_reported",
          catalogVersion: 1,
        },
      ],
    });

    const response = await new ScanResolverService(repo, hashIp()).resolve("asset-opaque-code");

    expect(response).toMatchObject({
      status: "available",
      category: "asset",
      fields: [expect.objectContaining({ key: "label", value: "Cylinder C-42" })],
    });
    expect(repo.getAssetPublicProjection).toHaveBeenCalledWith("asset-1", "tenant-1");
    expect(repo.getFilteredPublicProjection).not.toHaveBeenCalled();
  });

  it("cannot route a person tag through the asset projection", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({
      id: "person-tag-1",
      tenantId: "tenant-1",
      wardId: "ward-1",
      category: "medical",
      categoryKind: "consent_governed_person",
    });
    repo.getFilteredPublicProjection.mockResolvedValue({
      category: "medical",
      policyVersion: 1,
      fields: [],
    });

    await new ScanResolverService(repo, hashIp()).resolve("person-opaque-code");

    expect(repo.getFilteredPublicProjection).toHaveBeenCalledWith("ward-1");
    expect(repo.getAssetPublicProjection).not.toHaveBeenCalled();
  });

  it("keeps an asset tag neutral if its server-side allowlist projection is empty", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({
      id: "asset-tag-1",
      tenantId: "tenant-1",
      assetId: "asset-1",
      category: "asset",
      categoryKind: "plain_asset",
    });
    repo.getAssetPublicProjection.mockResolvedValue({
      category: "asset",
      policyVersion: 1,
      fields: [],
    });

    await expect(
      new ScanResolverService(repo, hashIp()).resolve("asset-no-fields"),
    ).resolves.toEqual({ status: "tag_unavailable" });
    expect(repo.writeScanLog).not.toHaveBeenCalled();
  });

  it("makes a bad short-code checksum indistinguishable in response shape from an unknown tag", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue(null);
    const service = new ScanResolverService(repo, hashIp());
    const unknown = await service.resolve("unknown-long-legacy-code");
    const validCode = createPublicTagCode();
    const badChecksum = `${validCode.slice(0, -1)}${validCode.endsWith("A") ? "B" : "A"}`;
    const badChecksumResponse = await service.resolve(badChecksum);

    expect(badChecksumResponse).toEqual(unknown);
    // The checksum path deliberately avoids a resolver lookup; its database
    // timing is therefore not claimed to be indistinguishable.
    expect(repo.findActiveTag).toHaveBeenCalledTimes(1);
  });

  it("returns the same neutral response for an inactive, lost, revoked, or unknown tag", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue(null);
    const response = await new ScanResolverService(repo, hashIp()).resolve("a-guess");
    expect(response).toEqual({ status: "tag_unavailable" });
    expect(repo.getFilteredPublicProjection).not.toHaveBeenCalled();
    expect(repo.writeScanLog).not.toHaveBeenCalled();
  });

  it("returns the neutral response when an available-tag resolution fails internally", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({
      id: "tag-1",
      tenantId: "tenant-1",
      wardId: "ward-1",
      category: "medical",
      categoryKind: "consent_governed_person",
    });
    repo.getFilteredPublicProjection.mockRejectedValue(new Error("permission denied"));

    const response = await new ScanResolverService(repo, hashIp()).resolve(
      "known-long-legacy-code",
    );

    expect(response).toEqual({ status: "tag_unavailable" });
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

  it("refuses public release for bounded free text outside the explicit allowlist", async () => {
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
      key: "critical_warning",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "text",
      validationPolicy: { max_length: 200 },
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

  it("permits the explicitly allowlisted condition_notes field to be released", async () => {
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
      key: "condition_notes",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "text",
      validationPolicy: { max_length: 1000 },
    });

    await new ConsentPrivacyService(repo).setVisibility({
      actorId: "guardian-1",
      wardId: "ward-1",
      catalogId: "catalog-1",
      visibility: "public",
      sessionMetadata: {},
    });

    expect(repo.setVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "catalog-1", visibility: "public" }),
    );
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

  it("sanitises condition_notes through the same free-text path before storage", async () => {
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
      key: "condition_notes",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "text",
      validationPolicy: { max_length: 1000 },
    });

    await new WardGuardiansService(repo).writeGuardianValue({
      userId: "guardian-1",
      wardId: "ward-1",
      catalogId: "catalog-1",
      value:
        '<strong>Needs help</strong>\nhttps://evil.test\n<a href="javascript:steal()">plain note</a>',
    });

    const stored = repo.upsertGuardianValue.mock.calls[0]![0].value as string;
    expect(stored).not.toMatch(/<[^>]*>/);
    expect(stored).not.toMatch(/https?:\/\//i);
    expect(stored).not.toMatch(/javascript:/i);
    expect(stored).toContain("Needs help");
    expect(stored).toContain("plain note");
  });

  it("rejects condition flag values outside the locked 12-key set", async () => {
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
      key: "condition_flags",
      approved: true,
      publicEligible: true,
      maxLevel: "public",
      dataType: "enum",
      validationPolicy: {
        allowed_values: [
          "epilepsy",
          "cardiac",
          "diabetes",
          "blood_thinner",
          "dialysis",
          "pacemaker_implant",
          "severe_allergy",
          "asthma_copd",
          "non_verbal",
          "hearing_impaired",
          "vision_impaired",
          "wandering",
        ],
        multi_select: true,
      },
    });

    await expect(
      new WardGuardiansService(repo).writeGuardianValue({
        userId: "guardian-1",
        wardId: "ward-1",
        catalogId: "catalog-1",
        value: ["epilepsy", "unknown_condition"],
      }),
    ).rejects.toThrow("Value is not allowed by the catalog policy");
    expect(repo.upsertGuardianValue).not.toHaveBeenCalled();
  });

  it("returns condition flags only when the filtered projection releases them", async () => {
    const repo = baseRepository();
    repo.findActiveTag.mockResolvedValue({
      id: "tag-1",
      tenantId: "tenant-1",
      wardId: "ward-1",
      category: "medical",
      categoryKind: "consent_governed_person",
    });
    repo.getFilteredPublicProjection.mockResolvedValueOnce({
      category: "medical",
      policyVersion: 1,
      fields: [], // Private visibility is removed by Consent & Privacy before this boundary.
    });
    repo.getFilteredPublicProjection.mockResolvedValueOnce({
      category: "medical",
      policyVersion: 1,
      fields: [
        {
          key: "condition_flags",
          label: "Condition flags",
          value: ["epilepsy"],
          provenance: "guardian_reported",
          catalogVersion: 1,
        },
      ],
    });
    const service = new ScanResolverService(repo, hashIp());

    const privateScan = await service.resolve("known-long-legacy-code");
    const releasedScan = await service.resolve("known-long-legacy-code");

    expect(privateScan).toEqual(expect.objectContaining({ fields: [] }));
    expect(releasedScan).toEqual(
      expect.objectContaining({ fields: [expect.objectContaining({ key: "condition_flags" })] }),
    );
  });
});
