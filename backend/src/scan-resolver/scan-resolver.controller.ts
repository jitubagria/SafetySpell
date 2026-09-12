import { Controller, Get, Param, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ScanResolverService } from "./scan-resolver.service";

@Controller("v1/public/scan")
export class ScanResolverController {
  constructor(private readonly scanResolver: ScanResolverService) {}

  @Get(":tagCode")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  scan(@Param("tagCode") tagCode: string, @Req() request: { ip?: string }) {
    return this.scanResolver.resolve(tagCode, request.ip);
  }
}
