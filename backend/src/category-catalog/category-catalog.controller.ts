import { Controller, Param, Put, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { CategoryCatalogService } from "./category-catalog.service";

@Controller("v1/staff/catalog")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("clinical_reviewer")
export class CategoryCatalogController {
  constructor(private readonly catalog: CategoryCatalogService) {}
  @Put(":catalogId/clinical-approval/public")
  async approve(@Param("catalogId") catalogId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.catalog.approveForPublicRelease(catalogId, user.id);
    return { status: "approved_for_public_release" };
  }
  @Put(":catalogId/private-only")
  async privateOnly(@Param("catalogId") catalogId: string) {
    await this.catalog.makePrivateOnly(catalogId);
    return { status: "private_only" };
  }
}
