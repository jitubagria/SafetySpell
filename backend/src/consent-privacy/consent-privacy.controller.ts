import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ConsentPrivacyService } from "./consent-privacy.service";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";

@Controller("v1/app/wards")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("guardian")
export class ConsentPrivacyController {
  constructor(private readonly consent: ConsentPrivacyService) {}
  @Post(":wardId/public-release/withdraw")
  async withdraw(@CurrentUser() user: AuthenticatedUser, @Param("wardId") wardId: string) {
    await this.consent.withdrawPublicRelease({
      actorId: user.id,
      wardId,
      sessionMetadata: { source: "guardian_api" },
    });
    return { status: "withdrawn", visibility: "private", note: "V1 has no action handles." };
  }

  @Get(":wardId/consent-audit")
  audit(@CurrentUser() user: AuthenticatedUser, @Param("wardId") wardId: string) {
    return this.consent.audit(user.id, wardId);
  }
}
