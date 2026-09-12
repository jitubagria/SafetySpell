import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class CategoryCatalogService {
  constructor(private readonly db: DatabaseService) {}
  async approveForPublicRelease(catalogId: string, reviewerId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE field_catalog SET approved = true, approved_by = $2, approved_at = now(), public_eligible = true, max_level = 'public', updated_at = now()
       WHERE id = $1
         AND data_type IN ('enum', 'boolean')
         AND jsonb_typeof(validation_policy->'allowed_values') = 'array'
         AND jsonb_array_length(validation_policy->'allowed_values') > 0`,
      [catalogId, reviewerId],
    );
    if (!result.rowCount) {
      throw new BadRequestException(
        "Only a catalog field with explicit controlled allowed values can be approved for public release",
      );
    }
  }
  async makePrivateOnly(catalogId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE field_catalog SET public_eligible = false, max_level = 'private', updated_at = now() WHERE id = $1`,
      [catalogId],
    );
    if (!result.rowCount) throw new NotFoundException("Catalog field not found");
  }
  validateV1MaxLevel(level: string): void {
    if (level !== "private" && level !== "public")
      throw new BadRequestException(
        "verified_emergency_responder is reserved and unavailable in V1",
      );
  }
}
