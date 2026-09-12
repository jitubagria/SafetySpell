import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { GuidanceService } from "./guidance.service";
@Controller("v1/staff/guidance")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("clinical_reviewer")
export class GuidanceController {
  constructor(private readonly guidance: GuidanceService) {}
  @Post(":ruleId/publish")
  async publish(@Param("ruleId") ruleId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.guidance.publish(ruleId, user.id);
    return { status: "published" };
  }
}
