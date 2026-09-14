import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import { normalizeTagCode } from "../domain/tag-code";

type HolderKind = "company" | "distributor" | "guardian";

type TagAuthorityRow = {
  id: string;
  holder_kind: HolderKind;
  holder_distributor_id: string | null;
  holder_guardian_user_id: string | null;
  category_id: string;
  actor_distributor_id: string | null;
};

@Injectable()
export class TagCustodyService {
  constructor(private readonly db: DatabaseService) {}

  /** The holder fields, not assignment history, are the authority source of truth. */
  async assertMayAct(actor: AuthenticatedUser, tagCode: string): Promise<void> {
    const tag = await this.db.query<TagAuthorityRow>(
      `SELECT t.id, t.holder_kind, t.holder_distributor_id, t.holder_guardian_user_id,
              t.category_id, actor.distributor_id AS actor_distributor_id
       FROM tags t JOIN users actor ON actor.id = $1 AND actor.status = 'active' AND actor.tenant_id = $2
       WHERE upper(t.code) = upper($3) AND t.tenant_id = $2`,
      [actor.id, actor.tenantId, normalizeTagCode(tagCode)],
    );
    const row = tag.rows[0];
    if (!row) throw new NotFoundException("Tag unavailable");
    if (actor.role === "company_admin" && row.holder_kind === "company") return;
    if (
      actor.role === "guardian" &&
      row.holder_kind === "guardian" &&
      row.holder_guardian_user_id === actor.id
    )
      return;
    if (
      actor.role === "distributor" &&
      row.holder_kind === "distributor" &&
      row.holder_distributor_id === row.actor_distributor_id
    ) {
      const allowed = await this.db.query(
        "SELECT 1 FROM distributor_allowed_categories WHERE distributor_id = $1 AND category_id = $2",
        [row.actor_distributor_id, row.category_id],
      );
      if (allowed.rowCount) return;
    }
    throw new ForbiddenException("Current tag custody does not permit this action");
  }

  async allocateBatch(actor: AuthenticatedUser, batchId: string, distributorId: string) {
    if (actor.role !== "company_admin")
      throw new ForbiddenException("Company admin authority is required");
    return this.db.transaction(async (client) => {
      const batch = await client.query<{ category_id: string }>(
        "SELECT category_id FROM tag_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [batchId, actor.tenantId],
      );
      if (!batch.rows[0]) throw new NotFoundException("Batch unavailable");
      const permitted = await client.query(
        `SELECT 1 FROM distributors d JOIN distributor_allowed_categories permission
           ON permission.distributor_id = d.id AND permission.category_id = $2
         WHERE d.id = $1 AND d.status = 'active'`,
        [distributorId, batch.rows[0].category_id],
      );
      if (!permitted.rowCount)
        throw new ForbiddenException("Distributor may not hold this category");
      const tags = await client.query<{ id: string }>(
        "SELECT id FROM tags WHERE batch_id = $1 AND tenant_id = $2 FOR UPDATE",
        [batchId, actor.tenantId],
      );
      if (!tags.rowCount) throw new NotFoundException("Batch unavailable");
      const ids = tags.rows.map((tag) => tag.id);
      const transferable = await client.query<{ id: string }>(
        `SELECT id FROM tags WHERE id = ANY($1::uuid[]) AND inventory_status = 'blank'
           AND holder_kind = 'company' AND tenant_id = $2 FOR UPDATE`,
        [ids, actor.tenantId],
      );
      if (transferable.rowCount !== ids.length)
        throw new BadRequestException("Only company-held blank tags may be allocated");

      await this.allocateLocked(client, ids, actor.id, actor.tenantId, distributorId);
      return { batchId, distributorId, count: ids.length };
    });
  }

  private async allocateLocked(
    client: PoolClient,
    tagIds: string[],
    actorId: string,
    tenantId: string | undefined,
    distributorId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE tags SET holder_kind = 'distributor', holder_distributor_id = $2,
         holder_guardian_user_id = NULL, source_distributor_id = COALESCE(source_distributor_id, $2),
         status_changed_at = now() WHERE id = ANY($1::uuid[]) AND tenant_id = $3`,
      [tagIds, distributorId, tenantId],
    );
    await client.query(
      `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
       SELECT id, 'allocated', $2::uuid, 'blank', 'blank',
              jsonb_build_object('source', 'company_allocation', 'to_distributor_id', $3::text)
       FROM unnest($1::uuid[]) AS id`,
      [tagIds, actorId, distributorId],
    );
  }
}
