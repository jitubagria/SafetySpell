import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class GuidanceService {
  constructor(private readonly db: DatabaseService) {}
  async publish(ruleId: string, reviewerId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE guidance_rules SET review_status = 'published', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND review_status IN ('draft', 'approved') AND (expires_at IS NULL OR expires_at > now())`,
      [ruleId, reviewerId],
    );
    if (!result.rowCount) throw new NotFoundException("Publishable guidance rule not found");
  }
}
