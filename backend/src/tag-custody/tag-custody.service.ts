import {
  BadRequestException,
  ConflictException,
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

type LockedStageTagRow = {
  id: string;
  code: string;
  tenant_id: string;
  inventory_status: string;
  holder_kind: HolderKind;
  current_stage_id: string | null;
};

type LiveActorRow = {
  id: string;
  status: string;
  role: string;
  tenant_role_id: string | null;
};

type TenantRoleRow = {
  id: string;
  active: boolean;
  authority_class: string;
};

export type StageMoveResult = {
  success: true;
  code: string;
  fromStageId: string;
  toStageId: string;
  eventId: string;
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

  /**
   * Stage movement is deliberately narrower than general custody authority:
   * only active operational staff may move company-held tags through an active
   * tenant route/hop that explicitly grants their tenant role.
   */
  async moveStage(
    actor: AuthenticatedUser,
    tagCode: string,
    fromStageId: string,
    toStageId: string,
  ): Promise<StageMoveResult> {
    const tenantId = actor.tenantId;
    if (!tenantId) throw new ForbiddenException("Tenant-scoped authentication is required");
    if (fromStageId === toStageId) throw new BadRequestException("Stage move must change stage");

    return this.db.transaction(async (client) => {
      // Lock the current tag row first. A competing move waits here and then
      // sees the changed current_stage_id as a stale request.
      const tagResult = await client.query<LockedStageTagRow>(
        `SELECT id, code, tenant_id, inventory_status, holder_kind, current_stage_id
         FROM tags
         WHERE upper(code) = upper($1) AND tenant_id = $2
         FOR UPDATE`,
        [normalizeTagCode(tagCode), tenantId],
      );
      const tag = tagResult.rows[0];
      if (!tag) throw new NotFoundException("Tag unavailable");
      return this.moveStageLocked(client, actor, tenantId, tag, fromStageId, toStageId, "staff_hop");
    });
  }

  /**
   * The tap pathway deliberately reuses the same locked movement core as the
   * explicit move API. Its caller obtains the destination from a server-side
   * staff-stage binding; it never accepts or performs initial placement.
   */
  async tapToBoundStage(actor: AuthenticatedUser, tagCode: string): Promise<StageMoveResult> {
    const tenantId = actor.tenantId;
    if (!tenantId) throw new ForbiddenException("Tenant-scoped authentication is required");

    return this.db.transaction(async (client) => {
      const bindingResult = await client.query<{ stage_id: string }>(
        `SELECT scope.stage_id
         FROM users actor
         JOIN tenant_roles role
           ON role.id = actor.tenant_role_id
          AND role.tenant_id = actor.tenant_id
          AND role.active = true
          AND role.authority_class = 'operational_staff'
         JOIN role_view_scopes scope
           ON scope.tenant_role_id = role.id
          AND scope.tenant_id = actor.tenant_id
          AND scope.active = true
          AND scope.scope_kind = 'own_stage'
         JOIN stages stage
           ON stage.id = scope.stage_id
          AND stage.tenant_id = actor.tenant_id
          AND stage.active = true
         WHERE actor.id = $1
           AND actor.tenant_id = $2
           AND actor.status = 'active'
           AND actor.role = 'staff'
         FOR SHARE OF actor, role, scope, stage`,
        [actor.id, tenantId],
      );
      const binding = bindingResult.rows[0];
      if (!binding) throw new ForbiddenException("No active staff-stage binding");

      const tagResult = await client.query<LockedStageTagRow>(
        `SELECT id, code, tenant_id, inventory_status, holder_kind, current_stage_id
         FROM tags
         WHERE upper(code) = upper($1) AND tenant_id = $2
         FOR UPDATE`,
        [normalizeTagCode(tagCode), tenantId],
      );
      const tag = tagResult.rows[0];
      if (!tag) throw new NotFoundException("Tag unavailable");
      if (!tag.current_stage_id)
        throw new BadRequestException("Tag is not currently placed on a route stage");

      return this.moveStageLocked(
        client,
        actor,
        tenantId,
        tag,
        tag.current_stage_id,
        binding.stage_id,
        "staff_stage_tap",
      );
    });
  }

  private async moveStageLocked(
    client: PoolClient,
    actor: AuthenticatedUser,
    tenantId: string,
    tag: LockedStageTagRow,
    fromStageId: string,
    toStageId: string,
    method: "staff_hop" | "staff_stage_tap",
  ): Promise<StageMoveResult> {
    if (!tag.current_stage_id)
      throw new BadRequestException("Tag is not currently placed on a route stage");
    if (tag.current_stage_id !== fromStageId)
      throw new ConflictException("Tag stage has changed; refresh before moving it");
    if (fromStageId === toStageId) throw new BadRequestException("Stage move must change stage");

    await this.assertMayMoveStageLocked(client, actor.id, tenantId, tag, fromStageId, toStageId);

    const update = await client.query<{ id: string }>(
      `UPDATE tags
       SET current_stage_id = $2
       WHERE id = $1 AND tenant_id = $3 AND current_stage_id = $4
       RETURNING id`,
      [tag.id, toStageId, tenantId, fromStageId],
    );
    if (!update.rowCount)
      throw new ConflictException("Tag stage has changed; refresh before moving it");

    // This event is intentionally written after the tag update: migration 024
    // validates that current_stage_id already equals to_stage_id and that the
    // lifecycle status has not changed.
    const event = await client.query<{ id: string }>(
      `INSERT INTO tag_events(
         tag_id, event_type, actor_user_id, from_status, to_status,
         from_stage_id, to_stage_id, metadata
       )
       VALUES($1, 'stage_moved', $2, $3, $3, $4, $5, jsonb_build_object('method', $6::text))
       RETURNING id`,
      [tag.id, actor.id, tag.inventory_status, fromStageId, toStageId, method],
    );

    return {
      success: true,
      code: tag.code,
      fromStageId,
      toStageId,
      eventId: event.rows[0]!.id,
    };
  }

  private async assertMayMoveStageLocked(
    client: PoolClient,
    actorId: string,
    tenantId: string,
    tag: LockedStageTagRow,
    fromStageId: string,
    toStageId: string,
  ): Promise<void> {
    // Re-read the actor inside the move transaction. JWT validation is an
    // earlier boundary; this is the live authority decision.
    const actorResult = await client.query<LiveActorRow>(
      `SELECT id, status, role, tenant_role_id
       FROM users
       WHERE id = $1 AND tenant_id = $2
       FOR SHARE`,
      [actorId, tenantId],
    );
    const actor = actorResult.rows[0];
    if (!actor || actor.status !== "active" || actor.role !== "staff")
      throw new ForbiddenException("Active staff authority is required for a stage move");
    if (!actor.tenant_role_id)
      throw new ForbiddenException("An active operational staff tenant role is required");

    // A shared lock prevents role deactivation from racing the move.
    const tenantRoleResult = await client.query<TenantRoleRow>(
      `SELECT id, active, authority_class
       FROM tenant_roles
       WHERE id = $1 AND tenant_id = $2
       FOR SHARE`,
      [actor.tenant_role_id, tenantId],
    );
    const tenantRole = tenantRoleResult.rows[0];
    if (!tenantRole || !tenantRole.active || tenantRole.authority_class !== "operational_staff") {
      throw new ForbiddenException("An active operational staff tenant role is required");
    }

    if (tag.holder_kind !== "company")
      throw new ForbiddenException("Only company-held tags may be moved by staff");

    // Derive the route from the server-owned stage rows. Shared locks cover all
    // mutable configuration used in the authorization decision, including the
    // permission itself and route/stage active flags.
    const hopResult = await client.query<{ route_id: string }>(
      `SELECT permission.route_id
       FROM route_stage_hop_permissions permission
       JOIN routes route
         ON route.id = permission.route_id
        AND route.tenant_id = permission.tenant_id
        AND route.active = true
       JOIN stages from_stage
         ON from_stage.id = permission.from_stage_id
        AND from_stage.route_id = permission.route_id
        AND from_stage.tenant_id = permission.tenant_id
        AND from_stage.active = true
       JOIN stages to_stage
         ON to_stage.id = permission.to_stage_id
        AND to_stage.route_id = permission.route_id
        AND to_stage.tenant_id = permission.tenant_id
        AND to_stage.active = true
       WHERE permission.tenant_id = $1
         AND permission.from_stage_id = $2
         AND permission.to_stage_id = $3
         AND permission.allowed_tenant_role_id = $4
         AND permission.active = true
       FOR SHARE OF permission, route, from_stage, to_stage`,
      [tenantId, fromStageId, toStageId, tenantRole.id],
    );
    if (!hopResult.rowCount)
      throw new ForbiddenException("No active stage-hop authority permits this move");
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
