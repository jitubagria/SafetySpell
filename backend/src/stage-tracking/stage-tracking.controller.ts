import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { StageTrackingService } from "./stage-tracking.service";

/** Internal operational board. This controller has no public route or DTO. */
@Controller("v1/app/stage-tracking")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("staff", "company_admin")
export class StageTrackingController {
  constructor(
    private readonly tracking: StageTrackingService,
  ) {}

  @Get("board")
  listBoard(@CurrentUser() actor: AuthenticatedUser) {
    return this.tracking.listBoard(actor);
  }
}
