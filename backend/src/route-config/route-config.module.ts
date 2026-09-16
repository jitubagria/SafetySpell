import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RouteConfigController } from "./route-config.controller";
import { RouteConfigService } from "./route-config.service";

@Module({
  imports: [DatabaseModule],
  controllers: [RouteConfigController],
  providers: [RouteConfigService],
  exports: [RouteConfigService],
})
export class RouteConfigModule {}
