import { Module } from "@nestjs/common";
import { StageTrackingController } from "./stage-tracking.controller";
import { StageTrackingService } from "./stage-tracking.service";
import { StagePlacementService } from "./stage-placement.service";
import { StagePlacementController } from "./stage-placement.controller";
import { TagCustodyModule } from "../tag-custody/tag-custody.module";
import { StageTapController } from "./stage-tap.controller";
import { StageTapService } from "./stage-tap.service";

@Module({
  imports: [TagCustodyModule],
  controllers: [StageTrackingController, StagePlacementController, StageTapController],
  providers: [StageTrackingService, StagePlacementService, StageTapService],
})
export class StageTrackingModule {}
