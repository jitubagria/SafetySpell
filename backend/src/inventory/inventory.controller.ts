import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { InventoryQuery, InventoryService } from "./inventory.service";

export class InventoryQueryDto implements InventoryQuery {
  @IsOptional()
  @IsIn(["blank", "assigned", "active", "lost", "revoked"])
  status?: "blank" | "assigned" | "active" | "lost" | "revoked";

  @IsOptional()
  @IsString()
  categoryKey?: string;

  @IsOptional()
  @IsString()
  distributorId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@Controller("v1/inventory")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin", "distributor")
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get("tags")
  listTags(@CurrentUser() user: AuthenticatedUser, @Query() query: InventoryQueryDto) {
    return this.inventoryService.listInventory(user, query);
  }
}
