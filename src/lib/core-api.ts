export type ApiVisibility = "private" | "public";

export interface ApiWard {
  id: string;
  category: string;
  name: string;
  status: string;
}

export interface ApiGuardianField {
  catalogId: string;
  key: "age_band" | "primary_language";
  label: string;
  value: unknown | null;
  provenance: "guardian_reported" | "clinician_verified";
  visibility: ApiVisibility;
  publicReleaseEligible: boolean;
}

export interface ApiScanResponse {
  status: "available" | "tag_unavailable";
  category?: string;
  fields?: Array<{
    key: string;
    label: string;
    value: unknown;
    provenance: "guardian_reported" | "clinician_verified";
  }>;
  disclaimer?: string;
}

const configuredUrl = import.meta.env.VITE_CORE_API_URL?.replace(/\/$/, "");
export const coreApiUrl =
  configuredUrl ?? (import.meta.env.DEV ? "http://localhost:3001" : undefined);

export class CoreApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function endpoint(path: string): string {
  if (!coreApiUrl) throw new CoreApiError("Core API is not configured for this build.", 0);
  return `${coreApiUrl}${path}`;
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String(payload.message)
        : `Request failed (${response.status})`;
    throw new CoreApiError(message, response.status);
  }
  return payload as T;
}

export async function login(email: string, password: string): Promise<string> {
  const result = await call<{ accessToken: string }>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return result.accessToken;
}

export function listWards(token: string): Promise<ApiWard[]> {
  return call<ApiWard[]>("/v1/app/wards", {}, token);
}

export function listFields(token: string, wardId: string): Promise<ApiGuardianField[]> {
  return call<ApiGuardianField[]>(`/v1/app/wards/${wardId}/fields`, {}, token);
}

export function writeField(
  token: string,
  wardId: string,
  catalogId: string,
  value: string,
): Promise<{ status: "updated" }> {
  return call(
    `/v1/app/wards/${wardId}/fields/${catalogId}`,
    { method: "PATCH", body: JSON.stringify({ value }) },
    token,
  );
}

export function setVisibility(
  token: string,
  wardId: string,
  catalogId: string,
  visibility: ApiVisibility,
): Promise<{ status: "updated"; visibility: ApiVisibility }> {
  return call(
    `/v1/app/wards/${wardId}/fields/${catalogId}/visibility`,
    { method: "PUT", body: JSON.stringify({ visibility }) },
    token,
  );
}

export function scanTag(tagCode: string): Promise<ApiScanResponse> {
  return call<ApiScanResponse>(`/v1/public/scan/${encodeURIComponent(tagCode)}`);
}
