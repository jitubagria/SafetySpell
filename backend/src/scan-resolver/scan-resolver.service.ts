import { Inject, Injectable } from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
import { isValidPublicTagCode, normalizeTagCode } from "../domain/tag-code";
import { PublicScanResponse } from "../domain/types";
import { ScanLogIpHasher } from "./scan-log-ip-hasher";

@Injectable()
export class ScanResolverService {
  constructor(
    @Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository,
    private readonly ipHasher: ScanLogIpHasher,
  ) {}

  async resolve(tagCode: string, ip?: string): Promise<PublicScanResponse> {
    const normalizedCode = normalizeTagCode(tagCode);
    // A bad short-code checksum is neutral and is rejected before the database.
    // Long legacy codes remain supported until old printed stock is exhausted.
    if (!isValidPublicTagCode(normalizedCode)) return { status: "tag_unavailable" };
    const tag = await this.repository.findActiveTag(normalizedCode);
    // Identical response for unknown, inactive, lost and revoked codes.
    if (!tag) return { status: "tag_unavailable" };
    const projection = await this.repository.getFilteredPublicProjection(tag.wardId);
    const guidance = await this.repository.getPublishedGuidance(
      projection.category,
      projection.fields.map((field) => field.key),
    );
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
      guidance,
      disclaimer: "Information is family-provided. This is not medical advice.",
    };
  }
}
