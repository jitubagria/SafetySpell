import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
} from "../common/request-user";
import { StageTapService } from "./stage-tap.service";

@Controller("v1/app/stage-tracking/tags")
@UseGuards(JwtAuthGuard)
export class StageTapController {
  constructor(private readonly taps: StageTapService) {}

  @Post(":tagCode/tap")
  tap(@CurrentUser() actor: AuthenticatedUser, @Param("tagCode") tagCode: string) {
    return this.taps.tap(actor, tagCode);
  }
}
