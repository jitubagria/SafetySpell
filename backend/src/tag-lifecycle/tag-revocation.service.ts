import { Injectable, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import { normalizeTagCode } from "../domain/tag-code";

export type TagRevocationResult = {
  code: string;
  status: "revoked";
  alreadyRevoked: boolean;
};

@Injectable()
export class TagRevocationService {
  constructor(private readonly db: DatabaseService) {}

  async revoke(actor: AuthenticatedUser, rawTagCode: string): Promise<TagRevocationResult> {
    const code = normalizeTagCode(rawTagCode);
    return this.db.transaction(async (client) => {
      const selected = await client.query<{
        id: string;
        code: string;
        inventory_status: "blank" | "assigned" | "active" | "lost" | "revoked";
      }>(
        `SELECT id, code, inventory_status
         FROM tags
         WHERE upper(code) = upper($1) AND tenant_id = $2
         FOR UPDATE`,
        [code, actor.tenantId],
      );
      const tag = selected.rows[0];
      if (!tag) throw new NotFoundException("Tag unavailable");

      // A retry must be safe during an incident and must not create a second audit event.
      if (tag.inventory_status === "revoked") {
        return { code: tag.code, status: "revoked", alreadyRevoked: true };
      }

      await client.query(
        `UPDATE tags
         SET inventory_status = 'revoked', status_changed_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [tag.id, actor.tenantId],
      );
      await client.query(
        `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
         VALUES($1, 'revoked', $2, $3, 'revoked', jsonb_build_object('method', 'company_admin_revoke'))`,
        [tag.id, actor.id, tag.inventory_status],
      );

      return { code: tag.code, status: "revoked", alreadyRevoked: false };
    });
  }
}
