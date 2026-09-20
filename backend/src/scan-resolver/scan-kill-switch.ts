/**
 * Level-2 public-scan kill switch. Operations enables it only through the
 * deployed backend environment: SCAN_KILL=true. It deliberately has no
 * browser/API control, so an unauthenticated request can never change it.
 */
export function isPublicScanKillEnabled(): boolean {
  return process.env.SCAN_KILL?.trim().toLowerCase() === "true";
}
