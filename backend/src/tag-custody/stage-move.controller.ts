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

class MoveStageDto {
  @IsUUID()
  fromStageId!: string;

  @IsUUID()
  toStageId!: string;
}

/** Internal staff operation; route and lifecycle state are never client supplied. */
@Controller("v1/app/tags")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("staff")
export class StageMoveController {
  constructor(private readonly custody: TagCustodyService) {}

  @Post(":tagCode/stage-moves")
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param("tagCode") tagCode: string,
    @Body() body: MoveStageDto,
  ) {
    return this.custody.moveStage(user, tagCode, body.fromStageId, body.toStageId);
  }
}
