import { Module } from "@nestjs/common";
import { CategoryCatalogController } from "./category-catalog.controller";
import { CategoryCatalogService } from "./category-catalog.service";
@Module({
  controllers: [CategoryCatalogController],
  providers: [CategoryCatalogService],
  exports: [CategoryCatalogService],
})
export class CategoryCatalogModule {}
