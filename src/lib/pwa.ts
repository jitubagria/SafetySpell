import { registerSW } from "virtual:pwa-register";

const previewHosts = ["lovableproject.com", "lovableproject-dev.com", "beta.lovable.dev"];

function isPreviewHost(hostname: string) {
  return (
    hostname.startsWith("id-preview--") ||
    hostname.startsWith("preview--") ||
    previewHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  );
}

async function removeAppWorker() {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => registration.active?.scriptURL.endsWith("/sw.js"))
      .map((registration) => registration.unregister()),
  );
}

export async function initializePwa() {
  if (!("serviceWorker" in navigator)) return;

  const disabled = new URLSearchParams(window.location.search).get("sw") === "off";
  const blocked =
    !import.meta.env.PROD || window.self !== window.top || isPreviewHost(window.location.hostname);

  if (disabled || blocked) {
    await removeAppWorker();
    return;
  }

  registerSW({ immediate: true });
}
