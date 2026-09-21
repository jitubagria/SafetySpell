import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { IsUUID } from "class-validator";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { StagePlacementService } from "./stage-placement.service";

class PlaceAtRouteStartDto {
  @IsUUID()
  routeId!: string;
}

/** Tenant-admin-only initial placement; deliberately separate from staff stage moves. */
@Controller("v1/admin/tags")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin")
export class StagePlacementController {
  constructor(private readonly placement: StagePlacementService) {}

  @Post(":tagCode/stage-placement")
  placeAtRouteStart(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("tagCode") tagCode: string,
    @Body() body: PlaceAtRouteStartDto,
  ) {
    return this.placement.placeAtRouteStart(actor, tagCode, body.routeId);
  }
}
