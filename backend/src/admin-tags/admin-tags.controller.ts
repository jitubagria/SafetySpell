import { Body, Controller, Get, Header, Param, Post, Res, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, IsString, Max, Min } from "class-validator";
import { Response } from "express";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { AdminTagsService } from "./admin-tags.service";
class CreateBatchDto {
  @IsString() categoryKey!: string;
  @IsIn(["band", "sticker", "card", "nfc_band", "plate"]) form!: string;
  @IsInt() @Min(1) @Max(500) quantity!: number;
}
@Controller("v1/admin/tag-batches")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("company_admin")
export class AdminTagsController {
  constructor(private readonly tags: AdminTagsService) {}
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBatchDto) {
    return this.tags.create(user.id, body);
  }
  @Get("tags/:tagCode.png") @Header("Content-Type", "image/png") async png(
    @Param("tagCode") code: string,
    @Res() response: Response,
  ) {
    response.send(await this.tags.png(code));
  }
  @Get(":batchId/print.pdf") @Header("Content-Type", "application/pdf") async pdf(
    @Param("batchId") id: string,
    @Res() response: Response,
  ) {
    response.send(await this.tags.pdf(id));
  }
}
