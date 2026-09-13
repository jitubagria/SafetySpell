import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { IsNotEmpty, IsString } from "class-validator";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/request-user";
import { TagAssignmentService } from "./tag-assignment.service";

class ClaimTagDto {
  @IsString()
  @IsNotEmpty()
  tagCode!: string;

  @IsString()
  @IsNotEmpty()
  pin!: string;
}

@Controller("v1/app/wards/:wardId/tags")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("guardian")
export class TagAssignmentController {
  constructor(private readonly assignmentService: TagAssignmentService) {}

  @Post("claim")
  claim(
    @CurrentUser() user: AuthenticatedUser,
    @Param("wardId") wardId: string,
    @Body() body: ClaimTagDto,
  ) {
    return this.assignmentService.claimTag(user, wardId, body.tagCode, body.pin);
  }
}
