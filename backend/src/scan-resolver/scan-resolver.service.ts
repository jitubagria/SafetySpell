import { Inject, Injectable, Logger } from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
import { isValidPublicTagCode, normalizeTagCode } from "../domain/tag-code";
import { PublicScanResponse } from "../domain/types";
import { ScanLogIpHasher } from "./scan-log-ip-hasher";

@Injectable()
export class ScanResolverService {
  private readonly logger = new Logger(ScanResolverService.name);

  constructor(
    @Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository,
    private readonly ipHasher: ScanLogIpHasher,
  ) {}

  async resolve(tagCode: string, ip?: string): Promise<PublicScanResponse> {
    try {
      const normalizedCode = normalizeTagCode(tagCode);
      // A bad short-code checksum is neutral and is rejected before the database.
      // Long legacy codes remain supported until old printed stock is exhausted.
      if (!isValidPublicTagCode(normalizedCode)) return { status: "tag_unavailable" };
      const tag = await this.repository.findActiveTag(normalizedCode);
      // Identical response for unknown, inactive, lost and revoked codes.
      if (!tag) return { status: "tag_unavailable" };
      const projection =
        tag.categoryKind === "consent_governed_person" && tag.wardId
          ? await this.repository.getFilteredPublicProjection(tag.wardId)
          : tag.categoryKind === "plain_asset" && tag.assetId
            ? await this.repository.getAssetPublicProjection(tag.assetId, tag.tenantId)
            : null;
      if (!projection) return { status: "tag_unavailable" };
      // An asset is never a live public tag until at least one released
      // allowlisted field has a value. Person consent behavior remains unchanged.
      if (tag.categoryKind === "plain_asset" && projection.fields.length === 0) {
        return { status: "tag_unavailable" };
      }
      await this.repository.writeScanLog({
        tagId: tag.id,
        policyVersion: projection.policyVersion,
        shownFieldKeys: projection.fields.map((field) => field.key),
        ipHash: this.ipHasher.hash(ip),
      });
      return {
        status: "available",
        category: projection.category,
        fields: projection.fields.map(({ key, label, value, provenance }) => ({
          key,
          label,
          value,
          provenance,
        })),
        disclaimer: "Information is family-provided. This is not medical advice.",
      };
    } catch (error) {
      this.logger.error(
        "Public scan resolution failed; returning neutral response",
        error instanceof Error ? error.stack : undefined,
      );
      return { status: "tag_unavailable" };
    }
  }
}
