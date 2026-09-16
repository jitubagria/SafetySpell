import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { AssetsService } from "./assets.service";

class ActivateAssetDto {
  @IsString()
  @IsNotEmpty()
  tagCode!: string;

  @IsString()
  @IsNotEmpty()
  categoryKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  assetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  returnReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNote?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  publicFields!: string[];
}

@Controller("v1/app/assets")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin", "staff")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post("activate")
  activate(@CurrentUser() user: AuthenticatedUser, @Body() body: ActivateAssetDto) {
    return this.assets.activate(user, body);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.list(user);
  }

  @Get(":assetId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("assetId") assetId: string) {
    return this.assets.get(user, assetId);
  }
}
