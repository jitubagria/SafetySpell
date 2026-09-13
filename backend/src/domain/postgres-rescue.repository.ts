import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { ActiveTag, PublicProjection, PublishedGuidance, Provenance, V1Visibility } from "./types";
import {
  CatalogField,
  GuardianField,
  GuardianWard,
  RescueRepository,
  WardTag,
} from "./rescue.repository";

type Row = Record<string, unknown>;
const asString = (row: Row, key: string): string => String(row[key]);

@Injectable()
export class PostgresRescueRepository implements RescueRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActiveTag(code: string): Promise<ActiveTag | null> {
    const result = await this.db.query<Row>(
      `SELECT t.id, t.ward_id, t.category FROM tags t
       JOIN wards w ON w.id = t.ward_id AND w.status = 'active'
       WHERE upper(t.code) = upper($1) AND t.status = 'active' AND t.ward_id IS NOT NULL`,
      [code],
    );
    const row = result.rows[0];
    return row
      ? {
          id: asString(row, "id"),
          wardId: asString(row, "ward_id"),
          category: asString(row, "category"),
        }
      : null;
  }

  async getFilteredPublicProjection(wardId: string): Promise<PublicProjection> {
    // This query deliberately joins only rows that cross every V1 public gate.
    const result = await this.db.query<Row>(
      `SELECT w.category, f.field_key, f.label, f.catalog_version, v.value, v.provenance
       FROM wards w
       JOIN ward_field_values v ON v.ward_id = w.id
       JOIN field_catalog f ON f.id = v.field_catalog_id
       JOIN ward_field_visibility visibility ON visibility.ward_id = w.id AND visibility.field_catalog_id = f.id
       WHERE w.id = $1 AND w.status = 'active'
         AND f.approved = true AND f.public_eligible = true AND f.max_level = 'public'
         AND visibility.visibility = 'public'`,
      [wardId],
    );
    const first = result.rows[0];
    const categoryResult = await this.db.query<Row>(
      "SELECT category FROM wards WHERE id = $1 AND status = $2",
      [wardId, "active"],
    );
    const categoryRow = categoryResult.rows[0];
    if (!categoryRow) throw new NotFoundException("Ward unavailable");
    const fields = result.rows.map((row) => ({
      key: asString(row, "field_key"),
      label: asString(row, "label"),
      value: row.value,
      provenance: asString(row, "provenance") as Provenance,
      catalogVersion: Number(row.catalog_version),
    }));
    return {
      category: first ? asString(first, "category") : asString(categoryRow, "category"),
      fields,
      policyVersion: Math.max(1, ...fields.map((field) => field.catalogVersion)),
    };
  }

  async getPublishedGuidance(
    category: string,
    releasedKeys: string[],
  ): Promise<PublishedGuidance[]> {
    const result = await this.db.query<Row>(
      `SELECT r.id, r.current_version, v.do_items, v.dont_items
       FROM guidance_rules r
       JOIN guidance_rule_versions v ON v.guidance_rule_id = r.id AND v.version = r.current_version
       WHERE r.category = $1 AND r.review_status = 'published'
         AND (r.expires_at IS NULL OR r.expires_at > now())
         AND (r.condition_key IS NULL OR r.condition_key = ANY($2::text[]))`,
      [category, releasedKeys],
    );
    return result.rows.map((row) => ({
      ruleId: asString(row, "id"),
      version: Number(row.current_version),
      do: row.do_items as string[],
      dont: row.dont_items as string[],
    }));
  }

  async writeScanLog(input: {
    tagId: string;
    policyVersion: number;
    shownFieldKeys: string[];
    ipHash?: string;
  }): Promise<void> {
    await this.db.query(
      "INSERT INTO scan_log(tag_id, policy_version, shown_field_keys, scanner_ip_hmac) VALUES ($1, $2, $3::jsonb, $4)",
      [input.tagId, input.policyVersion, JSON.stringify(input.shownFieldKeys), input.ipHash],
    );
  }

  async listAuthorizedWards(userId: string): Promise<GuardianWard[]> {
    const result = await this.db.query<Row>(
      `SELECT w.id, w.category, w.name, w.status FROM wards w JOIN ward_guardians g ON g.ward_id = w.id
       WHERE g.user_id = $1 AND g.active = true ORDER BY w.created_at`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: asString(row, "id"),
      category: asString(row, "category"),
      name: asString(row, "name"),
      status: asString(row, "status"),
    }));
  }

  async getAuthorizedWard(userId: string, wardId: string): Promise<GuardianWard | null> {
    const result = await this.db.query<Row>(
      `SELECT w.id, w.category, w.name, w.status FROM wards w JOIN ward_guardians g ON g.ward_id = w.id
       WHERE g.user_id = $1 AND w.id = $2 AND g.active = true`,
      [userId, wardId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: asString(row, "id"),
          category: asString(row, "category"),
          name: asString(row, "name"),
          status: asString(row, "status"),
        }
      : null;
  }

  async listAuthorizedWardTags(userId: string, wardId: string): Promise<WardTag[]> {
    // Authorisation is enforced in the join: only a guardian's own active tags surface,
    // and only the opaque code + form are returned — never ward data.
    const result = await this.db.query<Row>(
      `SELECT t.code, t.form FROM tags t
       JOIN ward_guardians g ON g.ward_id = t.ward_id AND g.user_id = $1 AND g.active = true
       WHERE t.ward_id = $2 AND t.status = 'active'
       ORDER BY t.created_at`,
      [userId, wardId],
    );
    return result.rows.map((row) => ({
      code: asString(row, "code"),
      form: asString(row, "form"),
    }));
  }

  async getAuthorizedFields(userId: string, wardId: string): Promise<GuardianField[]> {
    const allowed = await this.getAuthorizedWard(userId, wardId);
    if (!allowed) throw new ForbiddenException("No active guardian authorization");
    const result = await this.db.query<Row>(
      `SELECT f.id AS catalog_id, f.field_key, f.label, value.value, value.provenance,
              COALESCE(visibility.visibility, 'private') AS visibility,
              (f.approved = true AND f.public_eligible = true AND f.max_level = 'public'
               AND (
                 (f.data_type IN ('enum', 'boolean')
                  AND jsonb_typeof(f.validation_policy->'allowed_values') = 'array'
                  AND jsonb_array_length(f.validation_policy->'allowed_values') > 0)
                 OR
                 (f.data_type IN ('text', 'short_text')
                  AND jsonb_typeof(f.validation_policy->'max_length') = 'number')
               )) AS public_release_eligible
       FROM wards w
       JOIN field_catalog f ON f.category = w.category AND f.guardian_editable = true
       LEFT JOIN ward_field_values value ON value.ward_id = w.id AND value.field_catalog_id = f.id
       LEFT JOIN ward_field_visibility visibility ON visibility.ward_id = w.id AND visibility.field_catalog_id = f.id
       WHERE w.id = $1
       ORDER BY f.field_key`,
      [wardId],
    );
    return result.rows.map((row) => ({
      catalogId: asString(row, "catalog_id"),
      key: asString(row, "field_key"),
      label: asString(row, "label"),
      value: row.value,
      provenance: row.provenance
        ? (asString(row, "provenance") as Provenance)
        : "guardian_reported",
      visibility: asString(row, "visibility") as V1Visibility,
      publicReleaseEligible: Boolean(row.public_release_eligible),
    }));
  }

  async assertGuardianPermission(
    userId: string,
    wardId: string,
    permission: "fields" | "public_release",
  ): Promise<void> {
    const column = permission === "fields" ? "can_manage_fields" : "can_manage_public_release";
    const result = await this.db.query<Row>(
      `SELECT ${column} AS allowed FROM ward_guardians WHERE user_id = $1 AND ward_id = $2 AND active = true`,
      [userId, wardId],
    );
    if (!result.rows[0]?.allowed)
      throw new ForbiddenException("Guardian is not authorised for this operation");
  }

  async getCatalogField(catalogId: string, category: string): Promise<CatalogField | null> {
    const result = await this.db.query<Row>(
      "SELECT id, category, field_key, approved, public_eligible, max_level, data_type, validation_policy FROM field_catalog WHERE id = $1 AND category = $2",
      [catalogId, category],
    );
    const row = result.rows[0];
    return row
      ? {
          id: asString(row, "id"),
          category: asString(row, "category"),
          key: asString(row, "field_key"),
          approved: Boolean(row.approved),
          publicEligible: Boolean(row.public_eligible),
          maxLevel: asString(row, "max_level") as V1Visibility,
          dataType: asString(row, "data_type"),
          validationPolicy: row.validation_policy,
        }
      : null;
  }

  async upsertGuardianValue(input: {
    wardId: string;
    catalogId: string;
    value: unknown;
    actorId: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ward_field_values(ward_id, field_catalog_id, value, provenance, updated_by)
       VALUES ($1, $2, $3::jsonb, 'guardian_reported', $4)
       ON CONFLICT (ward_id, field_catalog_id) DO UPDATE SET value = EXCLUDED.value, provenance = 'guardian_reported', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [input.wardId, input.catalogId, JSON.stringify(input.value), input.actorId],
    );
  }

  async setVisibility(input: {
    wardId: string;
    catalogId: string;
    visibility: V1Visibility;
    actorId: string;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction(async (client) => {
      const prior = await client.query<Row>(
        "SELECT visibility FROM ward_field_visibility WHERE ward_id = $1 AND field_catalog_id = $2 FOR UPDATE",
        [input.wardId, input.catalogId],
      );
      const old = (prior.rows[0]?.visibility ?? "private") as V1Visibility;
      await client.query(
        `INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (ward_id, field_catalog_id) DO UPDATE SET visibility = EXCLUDED.visibility, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [input.wardId, input.catalogId, input.visibility, input.actorId],
      );
      await client.query(
        `INSERT INTO consent_audit(ward_id, field_catalog_id, event_type, old_visibility, new_visibility, changed_by, session_metadata)
         VALUES ($1, $2, 'visibility_changed', $3, $4, $5, $6::jsonb)`,
        [
          input.wardId,
          input.catalogId,
          old,
          input.visibility,
          input.actorId,
          JSON.stringify(input.sessionMetadata),
        ],
      );
    });
  }

  async withdrawPublicRelease(input: {
    wardId: string;
    actorId: string;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction(async (client) => {
      const changed = await client.query<Row>(
        `WITH changed AS (UPDATE ward_field_visibility SET visibility = 'private', updated_by = $2, updated_at = now()
          WHERE ward_id = $1 AND visibility = 'public' RETURNING field_catalog_id)
         INSERT INTO consent_audit(ward_id, field_catalog_id, event_type, old_visibility, new_visibility, changed_by, session_metadata)
         SELECT $1, field_catalog_id, 'visibility_changed', 'public', 'private', $2, $3::jsonb FROM changed RETURNING id`,
        [input.wardId, input.actorId, JSON.stringify(input.sessionMetadata)],
      );
      await client.query(
        `INSERT INTO consent_audit(ward_id, event_type, changed_by, session_metadata)
         VALUES ($1, 'public_release_withdrawn', $2, $3::jsonb)`,
        [
          input.wardId,
          input.actorId,
          JSON.stringify({ ...input.sessionMetadata, changedFields: changed.rowCount ?? 0 }),
        ],
      );
    });
  }

  async getConsentAudit(
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
  > {
    const ward = await this.getAuthorizedWard(userId, wardId);
    if (!ward) throw new ForbiddenException("No active guardian authorization");
    const result = await this.db.query<Row>(
      `SELECT audit.event_type, catalog.field_key, audit.old_visibility, audit.new_visibility, audit.created_at
       FROM consent_audit audit LEFT JOIN field_catalog catalog ON catalog.id = audit.field_catalog_id
       WHERE audit.ward_id = $1 ORDER BY audit.created_at DESC`,
      [wardId],
    );
    return result.rows.map((row) => ({
      eventType: asString(row, "event_type"),
      fieldKey: row.field_key ? asString(row, "field_key") : undefined,
      oldVisibility: row.old_visibility
        ? (asString(row, "old_visibility") as V1Visibility)
        : undefined,
      newVisibility: row.new_visibility
        ? (asString(row, "new_visibility") as V1Visibility)
        : undefined,
      createdAt: asString(row, "created_at"),
    }));
  }

  async getLatestPrivacyNotice(): Promise<{
    version: string;
    bodyMarkdown: string;
    publishedAt: string;
  } | null> {
    const result = await this.db.query<Row>(
      "SELECT version, body_markdown, published_at FROM privacy_notices WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    );
    const row = result.rows[0];
    return row
      ? {
          version: asString(row, "version"),
          bodyMarkdown: asString(row, "body_markdown"),
          publishedAt: asString(row, "published_at"),
        }
      : null;
  }

  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}
