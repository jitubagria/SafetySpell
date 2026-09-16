import { Module } from "@nestjs/common";
import { TagCustodyController } from "./tag-custody.controller";
import { StageMoveController } from "./stage-move.controller";
import { TagCustodyService } from "./tag-custody.service";

@Module({
  controllers: [TagCustodyController, StageMoveController],
  providers: [TagCustodyService],
  exports: [TagCustodyService],
})
export class TagCustodyModule {}
