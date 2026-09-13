import { Module } from "@nestjs/common";
import { AdminTagsController } from "./admin-tags.controller";
import { AdminTagsService } from "./admin-tags.service";
@Module({ controllers: [AdminTagsController], providers: [AdminTagsService] })
export class AdminTagsModule {}
