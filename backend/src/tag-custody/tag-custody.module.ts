import { Module } from "@nestjs/common";
import { TagCustodyController } from "./tag-custody.controller";
import { TagCustodyService } from "./tag-custody.service";

@Module({
  controllers: [TagCustodyController],
  providers: [TagCustodyService],
  exports: [TagCustodyService],
})
export class TagCustodyModule {}
