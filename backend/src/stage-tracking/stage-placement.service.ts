import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import { normalizeTagCode } from "../domain/tag-code";

@Injectable()
export class StagePlacementService {
  constructor(private readonly db: DatabaseService) {}

  async placeAtRouteStart(actor: AuthenticatedUser, tagCode: string, routeId: string) {
    if (!actor.tenantId) throw new ForbiddenException("Tenant-scoped authentication is required");
    const tenantId = actor.tenantId;

    return this.db.transaction(async (client) => {
      const liveAdmin = await client.query(
        `SELECT 1
         FROM users actor
         JOIN tenant_roles role
           ON role.id = actor.tenant_role_id AND role.tenant_id = actor.tenant_id
         WHERE actor.id = $1 AND actor.tenant_id = $2 AND actor.status = 'active'
           AND actor.role = 'company_admin' AND role.active = true AND role.authority_class = 'admin'
         FOR SHARE OF actor, role`,
        [actor.id, tenantId],
      );
      if (!liveAdmin.rowCount) throw new ForbiddenException("Active tenant admin authority is required");

      const tagResult = await client.query<{
        id: string;
        code: string;
        inventory_status: string;
        holder_kind: string;
        current_stage_id: string | null;
      }>(
        `SELECT id, code, inventory_status, holder_kind, current_stage_id
         FROM tags WHERE upper(code) = upper($1) AND tenant_id = $2 FOR UPDATE`,
        [normalizeTagCode(tagCode), tenantId],
      );
      const tag = tagResult.rows[0];
      if (!tag) throw new NotFoundException("Tag unavailable");
      if (tag.current_stage_id) throw new ConflictException("Tag is already placed on a route stage");
      if (tag.holder_kind !== "company")
        throw new ForbiddenException("Only company-held tags may be initially placed");

      const routeResult = await client.query<{ start_stage_id: string; stage_name: string }>(
        `SELECT route.start_stage_id, stage.name AS stage_name
         FROM routes route
         JOIN stages stage
           ON stage.id = route.start_stage_id
          AND stage.route_id = route.id
          AND stage.tenant_id = route.tenant_id
          AND stage.active = true
         WHERE route.id = $1 AND route.tenant_id = $2 AND route.active = true`,
        [routeId, tenantId],
      );
      const route = routeResult.rows[0];
      if (!route) throw new BadRequestException("Route must have an active configured start stage");

      await client.query(
        `UPDATE tags SET current_stage_id = $2
         WHERE id = $1 AND tenant_id = $3 AND current_stage_id IS NULL`,
        [tag.id, route.start_stage_id, tenantId],
      );
      const event = await client.query<{ id: string }>(
        `INSERT INTO tag_events(
           tag_id, event_type, actor_user_id, from_status, to_status, from_stage_id, to_stage_id, metadata
         ) VALUES($1, 'stage_placed', $2, $3, $3, NULL, $4,
           jsonb_build_object('method', 'tenant_admin_initial_placement', 'route_id', $5::text))
         RETURNING id`,
        [tag.id, actor.id, tag.inventory_status, route.start_stage_id, routeId],
      );
      return {
        success: true,
        code: tag.code,
        stageId: route.start_stage_id,
        stageName: route.stage_name,
        eventId: event.rows[0]!.id,
      };
    });
  }
}
