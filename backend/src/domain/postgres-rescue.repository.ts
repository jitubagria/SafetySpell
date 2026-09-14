import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import { CONDITION_FLAG_KEYS } from "../category-catalog/catalog-value-validation";
import { ActiveTag, PublicProjection, Provenance, V1Visibility } from "./types";
import {
  CatalogField,
  GuardianField,
  GuardianWard,
  RescueRepository,
  WardTag,
} from "./rescue.repository";

type Row = Record<string, unknown>;
const asString = (row: Row, key: string): string => String(row[key]);
const conditionFlagKeySet = new Set<string>(CONDITION_FLAG_KEYS);

function filteredPublicValue(key: string, value: unknown): unknown {
  if (key !== "condition_flags") return value;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" ? conditionFlagKeySet.has(entry) : false,
  );
}

@Injectable()
export class PostgresRescueRepository implements RescueRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActiveTag(code: string): Promise<ActiveTag | null> {
    const result = await this.db.query<Row>(
      `SELECT t.id, t.ward_id, t.category FROM tags t
       JOIN wards w ON w.id = t.ward_id AND w.status = 'active'
       WHERE upper(t.code) = upper($1) AND t.inventory_status = 'active' AND t.ward_id IS NOT NULL`,
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
    const fields = result.rows
      .map((row) => {
        const key = asString(row, "field_key");
        return {
          key,
          label: asString(row, "label"),
          value: filteredPublicValue(key, row.value),
          provenance: asString(row, "provenance") as Provenance,
          catalogVersion: Number(row.catalog_version),
        };
      })
      .filter((field) => field.key !== "condition_flags" || (field.value as string[]).length > 0);
    return {
      category: first ? asString(first, "category") : asString(categoryRow, "category"),
      fields,
      policyVersion: Math.max(1, ...fields.map((field) => field.catalogVersion)),
    };
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

  async listAuthorizedWards(userId: string, tenantId: string | undefined): Promise<GuardianWard[]> {
    const result = await this.db.query<Row>(
      `SELECT w.id, w.category, w.name, w.status FROM wards w JOIN ward_guardians g ON g.ward_id = w.id
       WHERE g.user_id = $1 AND w.tenant_id = $2 AND g.tenant_id = $2 AND g.active = true ORDER BY w.created_at`,
      [userId, tenantId],
    );
    return result.rows.map((row) => ({
      id: asString(row, "id"),
      category: asString(row, "category"),
      name: asString(row, "name"),
      status: asString(row, "status"),
    }));
  }

  async getAuthorizedWard(
    userId: string,
    tenantId: string | undefined,
    wardId: string,
  ): Promise<GuardianWard | null> {
    const result = await this.db.query<Row>(
      `SELECT w.id, w.category, w.name, w.status FROM wards w JOIN ward_guardians g ON g.ward_id = w.id
       WHERE g.user_id = $1 AND w.id = $3 AND w.tenant_id = $2 AND g.tenant_id = $2 AND g.active = true`,
      [userId, tenantId, wardId],
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

  async listAuthorizedWardTags(
    userId: string,
    tenantId: string | undefined,
    wardId: string,
  ): Promise<WardTag[]> {
    // Authorisation is enforced in the join: only a guardian's own active tags surface,
    // and only the opaque code + form are returned — never ward data.
    const result = await this.db.query<Row>(
      `SELECT t.code, t.form FROM tags t
       JOIN ward_guardians g ON g.ward_id = t.ward_id AND g.user_id = $1 AND g.tenant_id = $2 AND g.active = true
       WHERE t.ward_id = $3 AND t.tenant_id = $2 AND t.inventory_status = 'active'
       ORDER BY t.created_at`,
      [userId, tenantId, wardId],
    );
    return result.rows.map((row) => ({
      code: asString(row, "code"),
      form: asString(row, "form"),
    }));
  }

  async getAuthorizedFields(
    userId: string,
    tenantId: string | undefined,
    wardId: string,
  ): Promise<GuardianField[]> {
    const allowed = await this.getAuthorizedWard(userId, tenantId, wardId);
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
                 (f.field_key IN ('allergy', 'condition_notes')
                  AND f.data_type IN ('text', 'short_text')
                  AND jsonb_typeof(f.validation_policy->'max_length') = 'number')
               )) AS public_release_eligible
       FROM wards w
       JOIN field_catalog f ON f.category = w.category AND f.guardian_editable = true
       LEFT JOIN ward_field_values value ON value.ward_id = w.id AND value.field_catalog_id = f.id
       LEFT JOIN ward_field_visibility visibility ON visibility.ward_id = w.id AND visibility.field_catalog_id = f.id
       WHERE w.id = $1 AND w.tenant_id = $2
       ORDER BY f.field_key`,
      [wardId, tenantId],
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
    tenantId: string | undefined,
    wardId: string,
    permission: "fields" | "public_release",
  ): Promise<void> {
    const column = permission === "fields" ? "can_manage_fields" : "can_manage_public_release";
    const result = await this.db.query<Row>(
      `SELECT ${column} AS allowed FROM ward_guardians WHERE user_id = $1 AND tenant_id = $2 AND ward_id = $3 AND active = true`,
      [userId, tenantId, wardId],
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
    tenantId: string | undefined;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ward_field_values(ward_id, field_catalog_id, value, provenance, updated_by)
       SELECT $1, $2, $3::jsonb, 'guardian_reported', $4 FROM wards WHERE id = $1 AND tenant_id = $5
       ON CONFLICT (ward_id, field_catalog_id) DO UPDATE SET value = EXCLUDED.value, provenance = 'guardian_reported', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [input.wardId, input.catalogId, JSON.stringify(input.value), input.actorId, input.tenantId],
    );
  }

  async setVisibility(input: {
    wardId: string;
    catalogId: string;
    visibility: V1Visibility;
    actorId: string;
    tenantId: string | undefined;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction(async (client) => {
      const prior = await client.query<Row>(
        `SELECT visibility FROM ward_field_visibility visibility JOIN wards ward ON ward.id = visibility.ward_id
         WHERE visibility.ward_id = $1 AND visibility.field_catalog_id = $2 AND ward.tenant_id = $3 FOR UPDATE`,
        [input.wardId, input.catalogId, input.tenantId],
      );
      const old = (prior.rows[0]?.visibility ?? "private") as V1Visibility;
      await client.query(
        `INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by)
         SELECT $1, $2, $3, $4 FROM wards WHERE id = $1 AND tenant_id = $5
         ON CONFLICT (ward_id, field_catalog_id) DO UPDATE SET visibility = EXCLUDED.visibility, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [input.wardId, input.catalogId, input.visibility, input.actorId, input.tenantId],
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
    tenantId: string | undefined;
    sessionMetadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction(async (client) => {
      const changed = await client.query<Row>(
        `WITH changed AS (UPDATE ward_field_visibility SET visibility = 'private', updated_by = $2, updated_at = now()
          WHERE ward_id = $1 AND visibility = 'public' AND EXISTS (SELECT 1 FROM wards WHERE id = $1 AND tenant_id = $4) RETURNING field_catalog_id)
         INSERT INTO consent_audit(ward_id, field_catalog_id, event_type, old_visibility, new_visibility, changed_by, session_metadata)
         SELECT $1, field_catalog_id, 'visibility_changed', 'public', 'private', $2, $3::jsonb FROM changed RETURNING id`,
        [input.wardId, input.actorId, JSON.stringify(input.sessionMetadata), input.tenantId],
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
    tenantId: string | undefined,
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
    const ward = await this.getAuthorizedWard(userId, tenantId, wardId);
    if (!ward) throw new ForbiddenException("No active guardian authorization");
    const result = await this.db.query<Row>(
      `SELECT audit.event_type, catalog.field_key, audit.old_visibility, audit.new_visibility, audit.created_at
       FROM tenant_ledger_audit scope JOIN consent_audit audit ON audit.id = scope.ledger_id
       LEFT JOIN field_catalog catalog ON catalog.id = audit.field_catalog_id
       WHERE scope.ledger_type = 'consent_audit' AND scope.tenant_id = $2 AND audit.ward_id = $1 ORDER BY audit.created_at DESC`,
      [wardId, tenantId],
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
