/**
 * Environment helpers for SafetySpell.
 *
 * In production mode (`VITE_ENVIRONMENT === 'production'`), demo banners and
 * unwired/mock action controls (such as the unbuilt 'CALL FAMILY' button or
 * prototype bottom navigation) are completely suppressed from the UI to uphold
 * the product's honesty spine.
 */
export function isProduction(): boolean {
  return import.meta.env.VITE_ENVIRONMENT === "production";
}
