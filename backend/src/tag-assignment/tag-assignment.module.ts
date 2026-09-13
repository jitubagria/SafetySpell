import { Module } from "@nestjs/common";
import { TagAssignmentController } from "./tag-assignment.controller";
import { TagAssignmentService } from "./tag-assignment.service";

@Module({
  controllers: [TagAssignmentController],
  providers: [TagAssignmentService],
  exports: [TagAssignmentService],
})
export class TagAssignmentModule {}
