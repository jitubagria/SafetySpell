import { PoolClient } from "pg";
import { ActiveTag, PublicProjection, PublishedGuidance, Provenance, V1Visibility } from "./types";

export const RESCUE_REPOSITORY = Symbol("RESCUE_REPOSITORY");

export interface GuardianWard {
  id: string;
  category: string;
  name: string;
  status: string;
}
export interface GuardianField {
  catalogId: string;
  key: string;
  label: string;
  value: unknown;
  provenance: Provenance;
  visibility: V1Visibility;
}
export interface CatalogField {
  id: string;
  category: string;
  key: string;
  approved: boolean;
  publicEligible: boolean;
  maxLevel: V1Visibility;
  dataType: string;
  validationPolicy: unknown;
}

export interface RescueRepository {
  findActiveTag(code: string): Promise<ActiveTag | null>;
  /** The only public-profile read: query includes every consent gate. */
  getFilteredPublicProjection(wardId: string): Promise<PublicProjection>;
  getPublishedGuidance(category: string, releasedKeys: string[]): Promise<PublishedGuidance[]>;
  writeScanLog(input: {
    tagId: string;
    policyVersion: number;
    shownFieldKeys: string[];
    ipHash?: string;
  }): Promise<void>;
  listAuthorizedWards(userId: string): Promise<GuardianWard[]>;
  getAuthorizedWard(userId: string, wardId: string): Promise<GuardianWard | null>;
  getAuthorizedFields(userId: string, wardId: string): Promise<GuardianField[]>;
  assertGuardianPermission(
    userId: string,
    wardId: string,
    permission: "fields" | "public_release",
  ): Promise<void>;
  getCatalogField(catalogId: string, category: string): Promise<CatalogField | null>;
  upsertGuardianValue(input: {
    wardId: string;
    catalogId: string;
    value: unknown;
    actorId: string;
  }): Promise<void>;
  setVisibility(input: {
    wardId: string;
    catalogId: string;
    visibility: V1Visibility;
    actorId: string;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void>;
  withdrawPublicRelease(input: {
    wardId: string;
    actorId: string;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void>;
  getConsentAudit(
    userId: string,
    wardId: string,
  ): Promise<
    Array<{
      eventType: string;
      fieldKey?: string;
      oldVisibility?: V1Visibility;
      newVisibility?: V1Visibility;
      createdAt: string;
    }>
  >;
  verifyClinicalValue(input: {
    wardId: string;
    catalogId: string;
    verifierId: string;
    verificationNote?: string;
  }): Promise<void>;
  getLatestPrivacyNotice(): Promise<{
    version: string;
    bodyMarkdown: string;
    publishedAt: string;
  } | null>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
}
