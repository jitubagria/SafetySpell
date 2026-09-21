import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import {
  AssignUserTenantRoleDto,
  CreateHopDto,
  CreateRouteDto,
  CreateStageDto,
  CreateTenantRoleDto,
  UpdateHopDto,
  UpdateRouteDto,
  UpdateStageDto,
  UpdateTenantRoleDto,
} from "./dto/route-config.dto";

@Injectable()
export class RouteConfigService {
  constructor(private readonly db: DatabaseService) {}

  private requireTenantId(actor: AuthenticatedUser): string {
    const tenantId = actor.tenantId;
    if (!tenantId) throw new ForbiddenException("Tenant-scoped authentication is required");
    return tenantId;
  }

  // ==========================================
  // ROUTES
  // ==========================================

  async createRoute(actor: AuthenticatedUser, dto: CreateRouteDto) {
    const tenantId = this.requireTenantId(actor);
    const trimmedName = dto.name.trim();
    if (!trimmedName) throw new BadRequestException("Route name cannot be empty");

    const existing = await this.db.query<{ id: string }>(
      "SELECT id FROM routes WHERE tenant_id = $1 AND lower(name) = lower($2)",
      [tenantId, trimmedName],
    );
    if (existing.rowCount) throw new ConflictException("A route with this name already exists");

    const result = await this.db.query(
      `INSERT INTO routes(tenant_id, name)
       VALUES($1, $2)
       RETURNING id, tenant_id, name, active, start_stage_id, created_at, updated_at`,
      [tenantId, trimmedName],
    );
    return result.rows[0];
  }

  async listRoutes(actor: AuthenticatedUser) {
    const tenantId = this.requireTenantId(actor);
    const result = await this.db.query(
      `SELECT r.id, r.tenant_id, r.name, r.active, r.start_stage_id, r.created_at, r.updated_at,
              (SELECT count(*)::int FROM stages s WHERE s.route_id = r.id) AS stage_count,
              (SELECT count(*)::int FROM route_stage_hop_permissions h WHERE h.route_id = r.id AND h.active = true) AS active_hop_count
       FROM routes r
       WHERE r.tenant_id = $1
       ORDER BY r.created_at ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async getRoute(actor: AuthenticatedUser, routeId: string) {
    const tenantId = this.requireTenantId(actor);
    const routeResult = await this.db.query(
      `SELECT id, tenant_id, name, active, start_stage_id, created_at, updated_at
       FROM routes
       WHERE id = $1 AND tenant_id = $2`,
      [routeId, tenantId],
    );
    const route = routeResult.rows[0];
    if (!route) throw new NotFoundException("Route unavailable");

    const stagesResult = await this.db.query(
      `SELECT id, route_id, name, active, created_at, updated_at
       FROM stages
       WHERE route_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC`,
      [routeId, tenantId],
    );

    const hopsResult = await this.db.query(
      `SELECT h.id, h.route_id, h.from_stage_id, fs.name AS from_stage_name,
              h.to_stage_id, ts.name AS to_stage_name,
              h.allowed_tenant_role_id, tr.name AS allowed_tenant_role_name,
              tr.authority_class, h.active, h.created_at, h.updated_at
       FROM route_stage_hop_permissions h
       JOIN stages fs ON fs.id = h.from_stage_id
       JOIN stages ts ON ts.id = h.to_stage_id
       JOIN tenant_roles tr ON tr.id = h.allowed_tenant_role_id
       WHERE h.route_id = $1 AND h.tenant_id = $2
       ORDER BY h.created_at ASC`,
      [routeId, tenantId],
    );

    return {
      ...route,
      stages: stagesResult.rows,
      hops: hopsResult.rows,
    };
  }

  async updateRoute(actor: AuthenticatedUser, routeId: string, dto: UpdateRouteDto) {
    const tenantId = this.requireTenantId(actor);
    const existingResult = await this.db.query<{ id: string; name: string; active: boolean; start_stage_id: string | null }>(
      "SELECT id, name, active, start_stage_id FROM routes WHERE id = $1 AND tenant_id = $2",
      [routeId, tenantId],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new NotFoundException("Route unavailable");

    let newName = existing.name;
    if (dto.name !== undefined) {
      newName = dto.name.trim();
      if (!newName) throw new BadRequestException("Route name cannot be empty");
      if (newName.toLowerCase() !== existing.name.toLowerCase()) {
        const duplicate = await this.db.query(
          "SELECT id FROM routes WHERE tenant_id = $1 AND lower(name) = lower($2) AND id <> $3",
          [tenantId, newName, routeId],
        );
        if (duplicate.rowCount)
          throw new ConflictException("A route with this name already exists");
      }
    }

    let newStartStageId = existing.start_stage_id;
    if (dto.startStageId !== undefined) {
      const stage = await this.db.query<{ id: string }>(
        `SELECT id FROM stages
         WHERE id = $1 AND route_id = $2 AND tenant_id = $3 AND active = true`,
        [dto.startStageId, routeId, tenantId],
      );
      if (!stage.rowCount) throw new BadRequestException("Start stage must be an active stage on this route");
      newStartStageId = dto.startStageId;
    }

    if (dto.active === false) {
      return this.db.transaction(async (client) => {
        const updateRes = await client.query(
          `UPDATE routes
           SET name = $3, active = false, start_stage_id = $4, updated_at = now()
           WHERE id = $1 AND tenant_id = $2
           RETURNING id, tenant_id, name, active, start_stage_id, created_at, updated_at`,
          [routeId, tenantId, newName, newStartStageId],
        );

        // Cascade-deactivate child stages and hops (as active=false, not deleted)
        await client.query(
          `UPDATE stages SET active = false, updated_at = now()
           WHERE route_id = $1 AND tenant_id = $2 AND active = true`,
          [routeId, tenantId],
        );
        await client.query(
          `UPDATE route_stage_hop_permissions SET active = false, updated_at = now()
           WHERE route_id = $1 AND tenant_id = $2 AND active = true`,
          [routeId, tenantId],
        );

        // Count tags currently sitting on any stage in this route
        const strandedRes = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM tags t
           JOIN stages s ON s.id = t.current_stage_id
           WHERE s.route_id = $1 AND t.tenant_id = $2`,
          [routeId, tenantId],
        );

        return {
          ...updateRes.rows[0],
          strandedTagCount: strandedRes.rows[0]?.count ?? 0,
        };
      });
    }

    const newActive = dto.active !== undefined ? dto.active : existing.active;
    const updateRes = await this.db.query(
      `UPDATE routes
       SET name = $3, active = $4, start_stage_id = $5, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, name, active, start_stage_id, created_at, updated_at`,
      [routeId, tenantId, newName, newActive, newStartStageId],
    );
    return updateRes.rows[0];
  }

  // ==========================================
  // STAGES
  // ==========================================

  async createStage(actor: AuthenticatedUser, routeId: string, dto: CreateStageDto) {
    const tenantId = this.requireTenantId(actor);
    const trimmedName = dto.name.trim();
    if (!trimmedName) throw new BadRequestException("Stage name cannot be empty");

    const routeRes = await this.db.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM routes WHERE id = $1 AND tenant_id = $2",
      [routeId, tenantId],
    );
    const route = routeRes.rows[0];
    if (!route) throw new NotFoundException("Route unavailable");
    if (!route.active) throw new BadRequestException("Cannot add stages to an inactive route");

    const duplicate = await this.db.query(
      "SELECT id FROM stages WHERE route_id = $1 AND lower(name) = lower($2)",
      [routeId, trimmedName],
    );
    if (duplicate.rowCount) {
      throw new ConflictException("A stage with this name already exists on this route");
    }

    const result = await this.db.query(
      `INSERT INTO stages(tenant_id, route_id, name)
       VALUES($1, $2, $3)
       RETURNING id, tenant_id, route_id, name, active, created_at, updated_at`,
      [tenantId, routeId, trimmedName],
    );
    return result.rows[0];
  }

  async listStages(actor: AuthenticatedUser, routeId: string) {
    const tenantId = this.requireTenantId(actor);
    const routeRes = await this.db.query("SELECT id FROM routes WHERE id = $1 AND tenant_id = $2", [
      routeId,
      tenantId,
    ]);
    if (!routeRes.rowCount) throw new NotFoundException("Route unavailable");

    const result = await this.db.query(
      `SELECT id, tenant_id, route_id, name, active, created_at, updated_at
       FROM stages
       WHERE route_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC`,
      [routeId, tenantId],
    );
    return result.rows;
  }

  async updateStage(actor: AuthenticatedUser, stageId: string, dto: UpdateStageDto) {
    const tenantId = this.requireTenantId(actor);
    const existingRes = await this.db.query<{
      id: string;
      route_id: string;
      name: string;
      active: boolean;
    }>("SELECT id, route_id, name, active FROM stages WHERE id = $1 AND tenant_id = $2", [
      stageId,
      tenantId,
    ]);
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundException("Stage unavailable");

    let newName = existing.name;
    if (dto.name !== undefined) {
      newName = dto.name.trim();
      if (!newName) throw new BadRequestException("Stage name cannot be empty");
      if (newName.toLowerCase() !== existing.name.toLowerCase()) {
        const duplicate = await this.db.query(
          "SELECT id FROM stages WHERE route_id = $1 AND lower(name) = lower($2) AND id <> $3",
          [existing.route_id, newName, stageId],
        );
        if (duplicate.rowCount) {
          throw new ConflictException("A stage with this name already exists on this route");
        }
      }
    }

    if (dto.active === false) {
      return this.db.transaction(async (client) => {
        const updateRes = await client.query(
          `UPDATE stages
           SET name = $3, active = false, updated_at = now()
           WHERE id = $1 AND tenant_id = $2
           RETURNING id, tenant_id, route_id, name, active, created_at, updated_at`,
          [stageId, tenantId, newName],
        );

        // Cascade-deactivate hops referencing this stage
        await client.query(
          `UPDATE route_stage_hop_permissions
           SET active = false, updated_at = now()
           WHERE tenant_id = $1 AND (from_stage_id = $2 OR to_stage_id = $2) AND active = true`,
          [tenantId, stageId],
        );

        // Count tags currently sitting on this stage
        const strandedRes = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM tags WHERE tenant_id = $1 AND current_stage_id = $2",
          [tenantId, stageId],
        );

        return {
          ...updateRes.rows[0],
          strandedTagCount: strandedRes.rows[0]?.count ?? 0,
        };
      });
    }

    const newActive = dto.active !== undefined ? dto.active : existing.active;
    const updateRes = await this.db.query(
      `UPDATE stages
       SET name = $3, active = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, route_id, name, active, created_at, updated_at`,
      [stageId, tenantId, newName, newActive],
    );
    return updateRes.rows[0];
  }

  // ==========================================
  // HOPS
  // ==========================================

  async createHop(actor: AuthenticatedUser, routeId: string, dto: CreateHopDto) {
    const tenantId = this.requireTenantId(actor);
    if (dto.fromStageId === dto.toStageId) {
      throw new BadRequestException("Stage hop must connect distinct stages");
    }

    const routeRes = await this.db.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM routes WHERE id = $1 AND tenant_id = $2",
      [routeId, tenantId],
    );
    const route = routeRes.rows[0];
    if (!route) throw new NotFoundException("Route unavailable");

    const stagesRes = await this.db.query<{ id: string }>(
      `SELECT id FROM stages
       WHERE id = ANY($1::uuid[]) AND route_id = $2 AND tenant_id = $3`,
      [[dto.fromStageId, dto.toStageId], routeId, tenantId],
    );
    if (stagesRes.rowCount !== 2) {
      throw new NotFoundException("Stage unavailable");
    }

    const roleRes = await this.db.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM tenant_roles WHERE id = $1 AND tenant_id = $2",
      [dto.allowedTenantRoleId, tenantId],
    );
    if (!roleRes.rowCount) throw new NotFoundException("Tenant role unavailable");

    const duplicate = await this.db.query(
      `SELECT id FROM route_stage_hop_permissions
       WHERE tenant_id = $1 AND route_id = $2 AND from_stage_id = $3
         AND to_stage_id = $4 AND allowed_tenant_role_id = $5 AND active = true`,
      [tenantId, routeId, dto.fromStageId, dto.toStageId, dto.allowedTenantRoleId],
    );
    if (duplicate.rowCount) {
      throw new ConflictException("This hop permission already exists and is active");
    }

    const result = await this.db.query(
      `INSERT INTO route_stage_hop_permissions(
         tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id
       )
       VALUES($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id, active, created_at, updated_at`,
      [tenantId, routeId, dto.fromStageId, dto.toStageId, dto.allowedTenantRoleId],
    );
    return result.rows[0];
  }

  async listHops(actor: AuthenticatedUser, routeId: string) {
    const tenantId = this.requireTenantId(actor);
    const routeRes = await this.db.query("SELECT id FROM routes WHERE id = $1 AND tenant_id = $2", [
      routeId,
      tenantId,
    ]);
    if (!routeRes.rowCount) throw new NotFoundException("Route unavailable");

    const result = await this.db.query(
      `SELECT h.id, h.tenant_id, h.route_id, h.from_stage_id, fs.name AS from_stage_name,
              h.to_stage_id, ts.name AS to_stage_name,
              h.allowed_tenant_role_id, tr.name AS allowed_tenant_role_name,
              tr.authority_class, h.active, h.created_at, h.updated_at
       FROM route_stage_hop_permissions h
       JOIN stages fs ON fs.id = h.from_stage_id
       JOIN stages ts ON ts.id = h.to_stage_id
       JOIN tenant_roles tr ON tr.id = h.allowed_tenant_role_id
       WHERE h.route_id = $1 AND h.tenant_id = $2
       ORDER BY h.created_at ASC`,
      [routeId, tenantId],
    );
    return result.rows;
  }

  async updateHop(actor: AuthenticatedUser, hopId: string, dto: UpdateHopDto) {
    const tenantId = this.requireTenantId(actor);
    const hopRes = await this.db.query<{
      id: string;
      route_id: string;
      from_stage_id: string;
      to_stage_id: string;
      allowed_tenant_role_id: string;
      active: boolean;
    }>(
      "SELECT id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id, active FROM route_stage_hop_permissions WHERE id = $1 AND tenant_id = $2",
      [hopId, tenantId],
    );
    const hop = hopRes.rows[0];
    if (!hop) throw new NotFoundException("Hop permission unavailable");

    if (dto.active && !hop.active) {
      const duplicate = await this.db.query(
        `SELECT id FROM route_stage_hop_permissions
         WHERE tenant_id = $1 AND route_id = $2 AND from_stage_id = $3
           AND to_stage_id = $4 AND allowed_tenant_role_id = $5 AND active = true AND id <> $6`,
        [
          tenantId,
          hop.route_id,
          hop.from_stage_id,
          hop.to_stage_id,
          hop.allowed_tenant_role_id,
          hopId,
        ],
      );
      if (duplicate.rowCount) {
        throw new ConflictException("This hop permission already exists and is active");
      }
    }

    const result = await this.db.query(
      `UPDATE route_stage_hop_permissions
       SET active = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id, active, created_at, updated_at`,
      [hopId, tenantId, dto.active],
    );
    return result.rows[0];
  }

  // ==========================================
  // TENANT ROLES
  // ==========================================

  async createTenantRole(actor: AuthenticatedUser, dto: CreateTenantRoleDto) {
    const tenantId = this.requireTenantId(actor);
    const trimmedName = dto.name.trim();
    if (!trimmedName) throw new BadRequestException("Role name cannot be empty");

    const duplicate = await this.db.query(
      "SELECT id FROM tenant_roles WHERE tenant_id = $1 AND lower(name) = lower($2)",
      [tenantId, trimmedName],
    );
    if (duplicate.rowCount) throw new ConflictException("A role with this name already exists");

    const result = await this.db.query(
      `INSERT INTO tenant_roles(tenant_id, name, authority_class)
       VALUES($1, $2, $3)
       RETURNING id, tenant_id, name, authority_class, active, created_at, updated_at`,
      [tenantId, trimmedName, dto.authorityClass],
    );
    return result.rows[0];
  }

  async listTenantRoles(actor: AuthenticatedUser) {
    const tenantId = this.requireTenantId(actor);
    const result = await this.db.query(
      `SELECT id, tenant_id, name, authority_class, active, created_at, updated_at
       FROM tenant_roles
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async updateTenantRole(actor: AuthenticatedUser, roleId: string, dto: UpdateTenantRoleDto) {
    const tenantId = this.requireTenantId(actor);
    const existingRes = await this.db.query<{
      id: string;
      name: string;
      authority_class: string;
      active: boolean;
    }>(
      "SELECT id, name, authority_class, active FROM tenant_roles WHERE id = $1 AND tenant_id = $2",
      [roleId, tenantId],
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundException("Tenant role unavailable");

    let newName = existing.name;
    if (dto.name !== undefined) {
      newName = dto.name.trim();
      if (!newName) throw new BadRequestException("Role name cannot be empty");
      if (newName.toLowerCase() !== existing.name.toLowerCase()) {
        const duplicate = await this.db.query(
          "SELECT id FROM tenant_roles WHERE tenant_id = $1 AND lower(name) = lower($2) AND id <> $3",
          [tenantId, newName, roleId],
        );
        if (duplicate.rowCount) throw new ConflictException("A role with this name already exists");
      }
    }

    if (dto.active === false) {
      return this.db.transaction(async (client) => {
        const updateRes = await client.query(
          `UPDATE tenant_roles
           SET name = $3, active = false, updated_at = now()
           WHERE id = $1 AND tenant_id = $2
           RETURNING id, tenant_id, name, authority_class, active, created_at, updated_at`,
          [roleId, tenantId, newName],
        );

        // Cascade-deactivate hops referencing this role
        await client.query(
          `UPDATE route_stage_hop_permissions
           SET active = false, updated_at = now()
           WHERE tenant_id = $1 AND allowed_tenant_role_id = $2 AND active = true`,
          [tenantId, roleId],
        );

        return updateRes.rows[0];
      });
    }

    const newActive = dto.active !== undefined ? dto.active : existing.active;
    const updateRes = await this.db.query(
      `UPDATE tenant_roles
       SET name = $3, active = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, name, authority_class, active, created_at, updated_at`,
      [roleId, tenantId, newName, newActive],
    );
    return updateRes.rows[0];
  }

  // ==========================================
  // USER TENANT-ROLE ASSIGNMENT
  // ==========================================

  async assignUserTenantRole(
    actor: AuthenticatedUser,
    userId: string,
    dto: AssignUserTenantRoleDto,
  ) {
    const tenantId = this.requireTenantId(actor);
    const userRes = await this.db.query<{
      id: string;
      name: string;
      email: string;
      role: string;
      tenant_role_id: string | null;
    }>("SELECT id, name, email, role, tenant_role_id FROM users WHERE id = $1 AND tenant_id = $2", [
      userId,
      tenantId,
    ]);
    const user = userRes.rows[0];
    if (!user) throw new NotFoundException("User unavailable");

    if (!dto.tenantRoleId) {
      const updateRes = await this.db.query(
        `UPDATE users SET tenant_role_id = NULL
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, name, email, role, tenant_role_id`,
        [userId, tenantId],
      );
      return updateRes.rows[0];
    }

    const roleRes = await this.db.query<{
      id: string;
      name: string;
      authority_class: string;
      active: boolean;
    }>(
      "SELECT id, name, authority_class, active FROM tenant_roles WHERE id = $1 AND tenant_id = $2",
      [dto.tenantRoleId, tenantId],
    );
    const role = roleRes.rows[0];
    if (!role) throw new NotFoundException("Tenant role unavailable");
    if (!role.active) throw new BadRequestException("Cannot assign an inactive tenant role");

    // Coarse-role class drift validation
    if (role.authority_class === "operational_staff" && user.role !== "staff") {
      throw new BadRequestException("operational_staff tenant roles require users.role = staff");
    }
    if (role.authority_class === "guardian" && user.role !== "guardian") {
      throw new BadRequestException("guardian tenant roles require users.role = guardian");
    }
    if (role.authority_class === "admin" && user.role !== "company_admin") {
      throw new BadRequestException("admin tenant roles require users.role = company_admin");
    }

    const updateRes = await this.db.query(
      `UPDATE users SET tenant_role_id = $3
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, name, email, role, tenant_role_id`,
      [userId, tenantId, role.id],
    );
    return updateRes.rows[0];
  }
}
