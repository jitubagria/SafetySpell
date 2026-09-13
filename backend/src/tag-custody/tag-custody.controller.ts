import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { IsUUID } from "class-validator";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { TagCustodyService } from "./tag-custody.service";

class AllocateBatchDto {
  @IsUUID() distributorId!: string;
}

@Controller("v1/admin/tag-batches")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin")
export class TagCustodyController {
  constructor(private readonly custody: TagCustodyService) {}

  @Post(":batchId/allocate")
  allocate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("batchId") batchId: string,
    @Body() body: AllocateBatchDto,
  ) {
    return this.custody.allocateBatch(user, batchId, body.distributorId);
  }
}
