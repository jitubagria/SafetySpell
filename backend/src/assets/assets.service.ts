import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import { normalizeTagCode } from "../domain/tag-code";
import { AssetPublicFieldKey, isAssetPublicFieldKey } from "./asset-policy";

export type ActivateAssetInput = {
  tagCode: string;
  categoryKey: string;
  label?: string;
  assetType?: string;
  returnReference?: string;
  internalNote?: string;
  publicFields: string[];
};

type AssetRow = {
  id: string;
  category: string;
  label: string | null;
  asset_type: string | null;
  return_reference: string | null;
  internal_note: string | null;
  public_field_keys: string[];
};

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function assertAssetFields(input: ActivateAssetInput): AssetPublicFieldKey[] {
  const publicFields = [...new Set(input.publicFields)];
  if (!publicFields.length || !publicFields.every(isAssetPublicFieldKey)) {
    throw new BadRequestException("At least one recognized asset public field is required");
  }
  const values: Record<AssetPublicFieldKey, string | undefined> = {
    label: input.label,
    asset_type: input.assetType,
    return_reference: input.returnReference,
  };
  if (!publicFields.some((key) => hasText(values[key]))) {
    throw new BadRequestException("At least one released asset public field must have a value");
  }
  return publicFields;
}

@Injectable()
export class AssetsService {
  constructor(private readonly db: DatabaseService) {}

  async activate(actor: AuthenticatedUser, input: ActivateAssetInput) {
    if (actor.role !== "company_admin" && actor.role !== "staff") {
      throw new ForbiddenException("Tenant asset authority is required");
    }
    const publicFields = assertAssetFields(input);
    const code = normalizeTagCode(input.tagCode);

    return this.db.transaction(async (client) => {
      const category = await client.query<{ id: string }>(
        `SELECT id FROM categories
         WHERE key = $1 AND kind = 'plain_asset' AND status = 'active'`,
        [input.categoryKey],
      );
      if (!category.rows[0]) throw new BadRequestException("Asset category is unavailable");

      const tag = await client.query<{
        id: string;
        code: string;
        category_id: string;
        inventory_status: string;
        asset_id: string | null;
        activated_at: Date | null;
      }>(
        `SELECT id, code, category_id, inventory_status, asset_id, activated_at
         FROM tags WHERE upper(code) = upper($1) AND tenant_id = $2 FOR UPDATE`,
        [code, actor.tenantId],
      );
      const tagRow = tag.rows[0];
      if (!tagRow) throw new NotFoundException("Tag unavailable");
      if (tagRow.category_id !== category.rows[0].id) {
        throw new BadRequestException("Tag category does not match asset category");
      }
      if (tagRow.inventory_status === "active" && tagRow.asset_id) {
        return {
          success: true as const,
          code: tagRow.code,
          status: "active" as const,
          assetId: tagRow.asset_id,
          activatedAt: tagRow.activated_at,
        };
      }
      if (tagRow.inventory_status !== "blank" || tagRow.asset_id) {
        throw new BadRequestException(
          `Tag cannot be activated from status ${tagRow.inventory_status}`,
        );
      }

      const asset = await client.query<{ id: string }>(
        `INSERT INTO assets(
           tenant_id, category_id, label, asset_type, return_reference, internal_note,
           public_field_keys, created_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)
         RETURNING id`,
        [
          actor.tenantId,
          category.rows[0].id,
          input.label?.trim() || null,
          input.assetType?.trim() || null,
          input.returnReference?.trim() || null,
          input.internalNote?.trim() || null,
          publicFields,
          actor.id,
        ],
      );
      const assetId = asset.rows[0]!.id;
      await client.query(
        `UPDATE tags
         SET inventory_status = 'assigned', asset_id = $2, ward_id = NULL,
             holder_kind = 'company', holder_distributor_id = NULL,
             holder_guardian_user_id = NULL, assigned_guardian_user_id = NULL,
             assigned_by_user_id = $3, assigned_at = now(), status_changed_at = now(),
             activation_pin_hash = NULL, pin_failed_attempts = 0, pin_locked_until = NULL
         WHERE id = $1 AND tenant_id = $4`,
        [tagRow.id, assetId, actor.id, actor.tenantId],
      );
      await client.query(
        `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
         VALUES($1, 'assigned', $2, 'blank', 'assigned', jsonb_build_object('asset_id', $3::text, 'method', 'tenant_asset_activation'))`,
        [tagRow.id, actor.id, assetId],
      );
      const activated = await client.query<{ activated_at: Date }>(
        `UPDATE tags SET inventory_status = 'active', activated_at = now(), status_changed_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING activated_at`,
        [tagRow.id, actor.tenantId],
      );
      await client.query(
        `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
         VALUES($1, 'activated', $2, 'assigned', 'active', jsonb_build_object('asset_id', $3::text, 'method', 'tenant_asset_activation'))`,
        [tagRow.id, actor.id, assetId],
      );
      return {
        success: true as const,
        code: tagRow.code,
        status: "active" as const,
        assetId,
        activatedAt: activated.rows[0]!.activated_at,
      };
    });
  }

  async list(actor: AuthenticatedUser) {
    this.assertActor(actor);
    const result = await this.db.query<AssetRow>(
      `SELECT a.id, c.key AS category, a.label, a.asset_type, a.return_reference,
              a.internal_note, a.public_field_keys
       FROM assets a JOIN categories c ON c.id = a.category_id
       WHERE a.tenant_id = $1 ORDER BY a.created_at`,
      [actor.tenantId],
    );
    return result.rows.map((row) => this.assetResponse(row));
  }

  async get(actor: AuthenticatedUser, assetId: string) {
    this.assertActor(actor);
    const result = await this.db.query<AssetRow>(
      `SELECT a.id, c.key AS category, a.label, a.asset_type, a.return_reference,
              a.internal_note, a.public_field_keys
       FROM assets a JOIN categories c ON c.id = a.category_id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [assetId, actor.tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Asset unavailable");
    return this.assetResponse(row);
  }

  private assertActor(actor: AuthenticatedUser) {
    if (actor.role !== "company_admin" && actor.role !== "staff") {
      throw new ForbiddenException("Tenant asset authority is required");
    }
  }

  private assetResponse(row: AssetRow) {
    return {
      id: row.id,
      category: row.category,
      label: row.label,
      assetType: row.asset_type,
      returnReference: row.return_reference,
      internalNote: row.internal_note,
      publicFields: row.public_field_keys,
    };
  }
}
