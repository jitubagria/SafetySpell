export type ApiVisibility = "private" | "public";

export interface ApiWard {
  id: string;
  category: string;
  name: string;
  status: string;
}

export type ApiFieldKey =
  | "age_band"
  | "primary_language"
  | "blood_group"
  | "allergy"
  | "condition_flags"
  | "condition_notes";

export interface ApiGuardianField {
  catalogId: string;
  key: ApiFieldKey;
  label: string;
  value: unknown | null;
  provenance: "guardian_reported";
  visibility: ApiVisibility;
  publicReleaseEligible: boolean;
}

export interface ApiWardTag {
  code: string;
  form: string;
  status: "assigned" | "active";
}

export interface ApiScanResponse {
  status: "available" | "tag_unavailable";
  category?: string;
  fields?: Array<{
    key: string;
    label: string;
    value: unknown;
    provenance: "guardian_reported";
  }>;
  disclaimer?: string;
}

const configuredUrl = import.meta.env.VITE_CORE_API_URL?.replace(/\/$/, "");
export const coreApiUrl =
  configuredUrl ?? (import.meta.env.DEV ? "http://localhost:3001" : undefined);

// Base of the public, login-free scan web. Dev defaults to the local frontend origin;
// production must set VITE_PUBLIC_SCAN_BASE_URL to the real domain.
const configuredScanBase = import.meta.env.VITE_PUBLIC_SCAN_BASE_URL?.replace(/\/$/, "");
export const publicScanBaseUrl =
  configuredScanBase ?? (import.meta.env.DEV ? "http://localhost:8080" : undefined);

/** The public scan URL a QR encodes for an existing opaque tag code. */
export function scanUrlForTag(tagCode: string, base = publicScanBaseUrl): string | undefined {
  if (!base) return undefined;
  return `${base}/scan?tag=${encodeURIComponent(tagCode)}`;
}

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
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new CoreApiError("Could not reach the Core API. Check the connection and try again.", 0);
  }
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

export function listTags(token: string, wardId: string): Promise<ApiWardTag[]> {
  return call<ApiWardTag[]>(`/v1/app/wards/${wardId}/tags`, {}, token);
}

export function writeField(
  token: string,
  wardId: string,
  catalogId: string,
  value: unknown,
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

export function claimTag(
  token: string,
  wardId: string,
  tagCode: string,
  pin: string,
): Promise<{ success: boolean; code: string; wardId: string }> {
  return call(
    `/v1/app/wards/${wardId}/tags/claim`,
    { method: "POST", body: JSON.stringify({ tagCode, pin }) },
    token,
  );
}

export function activateTag(
  token: string,
  wardId: string,
  tagCode: string,
): Promise<{ success: boolean; code: string; status: "active"; activatedAt: string }> {
  return call(
    `/v1/app/wards/${wardId}/tags/${encodeURIComponent(tagCode)}/activate`,
    { method: "POST" },
    token,
  );
}

export interface ApiConsentAuditEntry {
  eventType: string;
  fieldKey?: string;
  oldVisibility?: ApiVisibility;
  newVisibility?: ApiVisibility;
  createdAt: string;
}

export function withdrawPublicRelease(
  token: string,
  wardId: string,
): Promise<{ status: "withdrawn"; visibility: "private"; note?: string }> {
  return call(
    `/v1/app/wards/${encodeURIComponent(wardId)}/public-release/withdraw`,
    { method: "POST" },
    token,
  );
}

export function getConsentAudit(token: string, wardId: string): Promise<ApiConsentAuditEntry[]> {
  return call(
    `/v1/app/wards/${encodeURIComponent(wardId)}/consent-audit`,
    { method: "GET" },
    token,
  );
}

export interface ApiInventoryItem {
  id: string;
  code: string;
  category: string;
  form: string;
  status: "blank" | "assigned" | "active" | "lost" | "revoked";
  holderKind: "company" | "distributor" | "guardian";
  distributorName?: string | null;
  sourceDistributorName?: string | null;
  assignedReference: string | null;
  createdAt: string;
  assignedAt: string | null;
  activatedAt: string | null;
  statusChangedAt: string | null;
}

export interface ApiInventoryCounts {
  blank: number;
  assigned: number;
  active: number;
  lost: number;
  revoked: number;
  total: number;
}

export interface ApiInventoryResult {
  items: ApiInventoryItem[];
  total: number;
  page: number;
  limit: number;
  counts: ApiInventoryCounts;
}

export interface ApiInventoryQuery {
  status?: "blank" | "assigned" | "active" | "lost" | "revoked";
  categoryKey?: string;
  distributorId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export function listInventory(
  token: string,
  query: ApiInventoryQuery = {},
): Promise<ApiInventoryResult> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.categoryKey) params.set("categoryKey", query.categoryKey);
  if (query.distributorId) params.set("distributorId", query.distributorId);
  if (query.search) params.set("search", query.search);
  if (query.fromDate) params.set("fromDate", query.fromDate);
  if (query.toDate) params.set("toDate", query.toDate);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));

  const qs = params.toString();
  return call<ApiInventoryResult>(`/v1/inventory/tags${qs ? `?${qs}` : ""}`, {}, token);
}

export function scanTag(tagCode: string): Promise<ApiScanResponse> {
  return call<ApiScanResponse>(`/v1/public/scan/${encodeURIComponent(tagCode)}`);
}

export interface ApiTagBatch {
  id: string;
  batchCode: string;
  codes: string[];
}
export function createTagBatch(
  token: string,
  input: { categoryKey: string; form: string; quantity: number },
): Promise<ApiTagBatch> {
  return call("/v1/admin/tag-batches", { method: "POST", body: JSON.stringify(input) }, token);
}

async function downloadAdminArtifact(token: string, path: string): Promise<Blob> {
  const response = await fetch(endpoint(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new CoreApiError(`Download failed (${response.status})`, response.status);
  return response.blob();
}

export function downloadAdminTagPng(token: string, code: string): Promise<Blob> {
  return downloadAdminArtifact(token, `/v1/admin/tag-batches/tags/${encodeURIComponent(code)}.png`);
}

export function downloadAdminBatchPdf(token: string, batchId: string): Promise<Blob> {
  return downloadAdminArtifact(
    token,
    `/v1/admin/tag-batches/${encodeURIComponent(batchId)}/print.pdf`,
  );
}

export function revokeAdminTag(
  token: string,
  tagCode: string,
): Promise<{ code: string; status: "revoked"; alreadyRevoked: boolean }> {
  return call(`/v1/admin/tags/${encodeURIComponent(tagCode)}/revoke`, { method: "POST" }, token);
}

export type ApiTenantRoleAuthorityClass =
  "unprivileged" | "operational_staff" | "guardian" | "admin";

export interface ApiRouteConfigRoute {
  id: string;
  tenant_id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  stage_count?: number;
  active_hop_count?: number;
  strandedTagCount?: number;
}

export interface ApiRouteConfigStage {
  id: string;
  tenant_id: string;
  route_id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  strandedTagCount?: number;
}

export interface ApiRouteConfigHop {
  id: string;
  tenant_id: string;
  route_id: string;
  from_stage_id: string;
  from_stage_name?: string;
  to_stage_id: string;
  to_stage_name?: string;
  allowed_tenant_role_id: string;
  allowed_tenant_role_name?: string;
  authority_class?: ApiTenantRoleAuthorityClass;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiTenantRole {
  id: string;
  tenant_id: string;
  name: string;
  authority_class: ApiTenantRoleAuthorityClass;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiRouteConfigDetail extends ApiRouteConfigRoute {
  stages: ApiRouteConfigStage[];
  hops: ApiRouteConfigHop[];
}

export interface CreateRouteInput {
  name: string;
}

export interface UpdateRouteInput {
  name?: string;
  active?: boolean;
}

export interface CreateStageInput {
  name: string;
}

export interface UpdateStageInput {
  name?: string;
  active?: boolean;
}

export interface CreateHopInput {
  fromStageId: string;
  toStageId: string;
  allowedTenantRoleId: string;
}

export interface UpdateHopInput {
  active: boolean;
}

export interface CreateTenantRoleInput {
  name: string;
  authorityClass: ApiTenantRoleAuthorityClass;
}

export interface UpdateTenantRoleInput {
  name?: string;
  active?: boolean;
}

export const routeConfigQueryKeys = {
  routes: (token: string) => ["route-config", "routes", token] as const,
  route: (token: string, routeId: string) => ["route-config", "route", token, routeId] as const,
  stages: (token: string, routeId: string) => ["route-config", "stages", token, routeId] as const,
  hops: (token: string, routeId: string) => ["route-config", "hops", token, routeId] as const,
  tenantRoles: (token: string) => ["route-config", "tenant-roles", token] as const,
};

export function createRouteConfigRoute(
  token: string,
  input: CreateRouteInput,
): Promise<ApiRouteConfigRoute> {
  return call<ApiRouteConfigRoute>(
    "/v1/admin/routes",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function listRouteConfigRoutes(token: string): Promise<ApiRouteConfigRoute[]> {
  return call<ApiRouteConfigRoute[]>("/v1/admin/routes", {}, token);
}

export function getRouteConfigRoute(token: string, routeId: string): Promise<ApiRouteConfigDetail> {
  return call<ApiRouteConfigDetail>(`/v1/admin/routes/${encodeURIComponent(routeId)}`, {}, token);
}

export function updateRouteConfigRoute(
  token: string,
  routeId: string,
  input: UpdateRouteInput,
): Promise<ApiRouteConfigRoute> {
  return call<ApiRouteConfigRoute>(
    `/v1/admin/routes/${encodeURIComponent(routeId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}

export function createRouteConfigStage(
  token: string,
  routeId: string,
  input: CreateStageInput,
): Promise<ApiRouteConfigStage> {
  return call<ApiRouteConfigStage>(
    `/v1/admin/routes/${encodeURIComponent(routeId)}/stages`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function listRouteConfigStages(
  token: string,
  routeId: string,
): Promise<ApiRouteConfigStage[]> {
  return call<ApiRouteConfigStage[]>(
    `/v1/admin/routes/${encodeURIComponent(routeId)}/stages`,
    {},
    token,
  );
}

export function updateRouteConfigStage(
  token: string,
  stageId: string,
  input: UpdateStageInput,
): Promise<ApiRouteConfigStage> {
  return call<ApiRouteConfigStage>(
    `/v1/admin/stages/${encodeURIComponent(stageId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}

export function createRouteConfigHop(
  token: string,
  routeId: string,
  input: CreateHopInput,
): Promise<ApiRouteConfigHop> {
  return call<ApiRouteConfigHop>(
    `/v1/admin/routes/${encodeURIComponent(routeId)}/hops`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function listRouteConfigHops(token: string, routeId: string): Promise<ApiRouteConfigHop[]> {
  return call<ApiRouteConfigHop[]>(
    `/v1/admin/routes/${encodeURIComponent(routeId)}/hops`,
    {},
    token,
  );
}

export function updateRouteConfigHop(
  token: string,
  hopId: string,
  input: UpdateHopInput,
): Promise<ApiRouteConfigHop> {
  return call<ApiRouteConfigHop>(
    `/v1/admin/hops/${encodeURIComponent(hopId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}

export function createRouteConfigTenantRole(
  token: string,
  input: CreateTenantRoleInput,
): Promise<ApiTenantRole> {
  return call<ApiTenantRole>(
    "/v1/admin/tenant-roles",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function listRouteConfigTenantRoles(token: string): Promise<ApiTenantRole[]> {
  return call<ApiTenantRole[]>("/v1/admin/tenant-roles", {}, token);
}

export function updateRouteConfigTenantRole(
  token: string,
  roleId: string,
  input: UpdateTenantRoleInput,
): Promise<ApiTenantRole> {
  return call<ApiTenantRole>(
    `/v1/admin/tenant-roles/${encodeURIComponent(roleId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    token,
  );
}
