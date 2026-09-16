import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
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
import { RouteConfigService } from "./route-config.service";

@Controller("v1/admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin")
export class RouteConfigController {
  constructor(private readonly config: RouteConfigService) {}

  // ==========================================
  // ROUTES
  // ==========================================

  @Post("routes")
  createRoute(@CurrentUser() actor: AuthenticatedUser, @Body() body: CreateRouteDto) {
    return this.config.createRoute(actor, body);
  }

  @Get("routes")
  listRoutes(@CurrentUser() actor: AuthenticatedUser) {
    return this.config.listRoutes(actor);
  }

  @Get("routes/:routeId")
  getRoute(@CurrentUser() actor: AuthenticatedUser, @Param("routeId") routeId: string) {
    return this.config.getRoute(actor, routeId);
  }

  @Patch("routes/:routeId")
  updateRoute(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("routeId") routeId: string,
    @Body() body: UpdateRouteDto,
  ) {
    return this.config.updateRoute(actor, routeId, body);
  }

  // ==========================================
  // STAGES
  // ==========================================

  @Post("routes/:routeId/stages")
  createStage(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("routeId") routeId: string,
    @Body() body: CreateStageDto,
  ) {
    return this.config.createStage(actor, routeId, body);
  }

  @Get("routes/:routeId/stages")
  listStages(@CurrentUser() actor: AuthenticatedUser, @Param("routeId") routeId: string) {
    return this.config.listStages(actor, routeId);
  }

  @Patch("stages/:stageId")
  updateStage(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("stageId") stageId: string,
    @Body() body: UpdateStageDto,
  ) {
    return this.config.updateStage(actor, stageId, body);
  }

  // ==========================================
  // HOPS
  // ==========================================

  @Post("routes/:routeId/hops")
  createHop(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("routeId") routeId: string,
    @Body() body: CreateHopDto,
  ) {
    return this.config.createHop(actor, routeId, body);
  }

  @Get("routes/:routeId/hops")
  listHops(@CurrentUser() actor: AuthenticatedUser, @Param("routeId") routeId: string) {
    return this.config.listHops(actor, routeId);
  }

  @Patch("hops/:hopId")
  updateHop(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("hopId") hopId: string,
    @Body() body: UpdateHopDto,
  ) {
    return this.config.updateHop(actor, hopId, body);
  }

  // ==========================================
  // TENANT ROLES
  // ==========================================

  @Post("tenant-roles")
  createTenantRole(@CurrentUser() actor: AuthenticatedUser, @Body() body: CreateTenantRoleDto) {
    return this.config.createTenantRole(actor, body);
  }

  @Get("tenant-roles")
  listTenantRoles(@CurrentUser() actor: AuthenticatedUser) {
    return this.config.listTenantRoles(actor);
  }

  @Patch("tenant-roles/:roleId")
  updateTenantRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("roleId") roleId: string,
    @Body() body: UpdateTenantRoleDto,
  ) {
    return this.config.updateTenantRole(actor, roleId, body);
  }

  // ==========================================
  // USER TENANT-ROLE ASSIGNMENT
  // ==========================================

  @Patch("users/:userId/tenant-role")
  assignUserTenantRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("userId") userId: string,
    @Body() body: AssignUserTenantRoleDto,
  ) {
    return this.config.assignUserTenantRole(actor, userId, body);
  }
}
