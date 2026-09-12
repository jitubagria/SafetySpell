import { Module } from "@nestjs/common";
import { RESCUE_REPOSITORY } from "../domain/rescue.repository";
import { PostgresRescueRepository } from "../domain/postgres-rescue.repository";
import { ScanResolverController } from "./scan-resolver.controller";
import { ScanLogIpHasher } from "./scan-log-ip-hasher";
import { ScanResolverService } from "./scan-resolver.service";

@Module({
  controllers: [ScanResolverController],
  providers: [
    ScanResolverService,
    ScanLogIpHasher,
    PostgresRescueRepository,
    { provide: RESCUE_REPOSITORY, useExisting: PostgresRescueRepository },
  ],
  exports: [ScanResolverService, RESCUE_REPOSITORY],
})
export class ScanResolverModule {}
