import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { TagRevocationService } from "./tag-revocation.service";

@Controller("v1/admin/tags")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin")
export class TagRevocationController {
  constructor(private readonly revocation: TagRevocationService) {}

  @Post(":tagCode/revoke")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("tagCode") tagCode: string) {
    return this.revocation.revoke(user, tagCode);
  }
}
