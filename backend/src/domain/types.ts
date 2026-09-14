export type V1Visibility = "private" | "public";
export type Provenance = "guardian_reported";

export interface ActiveTag {
  id: string;
  wardId: string;
  category: string;
}
export interface PublicField {
  key: string;
  label: string;
  value: unknown;
  provenance: Provenance;
  catalogVersion: number;
}
export interface PublicProjection {
  category: string;
  fields: PublicField[];
  policyVersion: number;
}
export interface PublicScanResponse {
  status: "available" | "tag_unavailable";
  category?: string;
  fields?: Array<Pick<PublicField, "key" | "label" | "value" | "provenance">>;
  disclaimer?: string;
}
