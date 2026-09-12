import { Controller, Get } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { RESCUE_REPOSITORY, RescueRepository } from "../domain/rescue.repository";
@Controller("v1/privacy-notices")
export class PrivacyNoticeController {
  constructor(@Inject(RESCUE_REPOSITORY) private readonly repository: RescueRepository) {}
  @Get("current")
  async current() {
    const notice = await this.repository.getLatestPrivacyNotice();
    return (
      notice ?? {
        status: "notice_unavailable",
        message: "A published privacy notice has not been configured.",
      }
    );
  }
}
