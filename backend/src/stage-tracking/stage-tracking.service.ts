import { ForbiddenException, Injectable } from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";

export type StageTrackingBoardItem = {
  tagCode: string;
  currentStage: { id: string; name: string } | null;
};

@Injectable()
export class StageTrackingService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Adds only rows justified by the actor's active, live tenant role scope.
   * This is intentionally separate from inventory: it selects no ward,
   * guardian, consent, profile, or health columns.
   */
  async listBoard(actor: AuthenticatedUser): Promise<StageTrackingBoardItem[]> {
    if (!actor.tenantId) throw new ForbiddenException("Tenant-scoped authentication is required");

    const result = await this.db.query<{
      code: string;
      stage_id: string | null;
      stage_name: string | null;
    }>(
      `WITH live_actor_scope AS (
         SELECT scope.tenant_role_id, scope.scope_kind
         FROM users actor
         JOIN tenant_roles role
           ON role.id = actor.tenant_role_id
          AND role.tenant_id = actor.tenant_id
          AND role.active = true
         JOIN role_view_scopes scope
           ON scope.tenant_role_id = role.id
          AND scope.tenant_id = actor.tenant_id
          AND scope.active = true
         WHERE actor.id = $1
           AND actor.tenant_id = $2
           AND actor.status = 'active'
           AND (
             (actor.role = 'staff' AND role.authority_class = 'operational_staff')
             OR (actor.role = 'company_admin' AND role.authority_class = 'admin')
           )
       ),
       allowed_tags AS (
         -- own-stage and unit scopes add only their allowed active-stage rows.
         SELECT tag.id, tag.code, tag.current_stage_id
         FROM live_actor_scope scope
         JOIN role_view_scope_allowed_stages allowed
           ON allowed.tenant_role_id = scope.tenant_role_id
          AND allowed.tenant_id = $2
         JOIN tags tag
           ON tag.tenant_id = $2
          AND tag.current_stage_id = allowed.stage_id

         UNION

         -- A tenant scope explicitly adds every tag in this one tenant,
         -- including unplaced tags. There is no client-supplied tenant input.
         SELECT tag.id, tag.code, tag.current_stage_id
         FROM live_actor_scope scope
         JOIN tags tag ON tag.tenant_id = $2
         WHERE scope.scope_kind = 'tenant'
       )
       SELECT allowed.code, stage.id AS stage_id, stage.name AS stage_name
       FROM allowed_tags allowed
       LEFT JOIN stages stage
         ON stage.id = allowed.current_stage_id
        AND stage.tenant_id = $2
       ORDER BY allowed.code ASC`,
      [actor.id, actor.tenantId],
    );

    return result.rows.map((row) => ({
      tagCode: row.code,
      currentStage:
        row.stage_id && row.stage_name ? { id: row.stage_id, name: row.stage_name } : null,
    }));
  }
}
