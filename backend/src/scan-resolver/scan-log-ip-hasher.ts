import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";

/** Never return a raw IP. Missing configuration degrades to no IP-derived log value. */
export function hmacScanIp(ip: string | undefined, secret: string | undefined): string | undefined {
  if (!ip || !secret) return undefined;
  return createHmac("sha256", secret).update(ip).digest("hex");
}

@Injectable()
export class ScanLogIpHasher {
  constructor(private readonly config: ConfigService) {}

  hash(ip?: string): string | undefined {
    return hmacScanIp(ip, this.config.get<string>("SCAN_LOG_IP_HMAC_SECRET"));
  }
}
