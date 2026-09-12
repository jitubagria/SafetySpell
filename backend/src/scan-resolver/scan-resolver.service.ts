import { Inject, Injectable } from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
import { PublicScanResponse } from "../domain/types";
import { ScanLogIpHasher } from "./scan-log-ip-hasher";

@Injectable()
export class ScanResolverService {
  constructor(
    @Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository,
    private readonly ipHasher: ScanLogIpHasher,
  ) {}

  async resolve(tagCode: string, ip?: string): Promise<PublicScanResponse> {
    const tag = await this.repository.findActiveTag(tagCode);
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
      disclaimer:
        "Information is family-provided unless explicitly identified as clinician-verified. This is not medical advice.",
    };
  }
}
