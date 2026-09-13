import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";
import { normalizeActivationPin, normalizeTagCode } from "../domain/tag-code";

// Fixed dummy hash for constant-time mitigation when tag or PIN record is missing
const DUMMY_BCRYPT_HASH = "$2b$08$212121212121212121212u4iFp8CgYF4r9/J.Vq6c2X5g4f.7mB2O";

export interface ClaimResult {
  success: true;
  code: string;
  wardId: string;
}

@Injectable()
export class TagAssignmentService {
  constructor(private readonly db: DatabaseService) {}

  async claimTag(
    actor: AuthenticatedUser,
    wardId: string,
    rawTagCode: string,
    rawPin: string,
  ): Promise<ClaimResult> {
    const normalizedCode = normalizeTagCode(rawTagCode);
    const normalizedPin = normalizeActivationPin(rawPin);

    // Verify guardian authority over ward
    const wardAuth = await this.db.query(
      `SELECT w.id FROM wards w
       JOIN ward_guardians g ON g.ward_id = w.id AND g.user_id = $1 AND g.active = true
       WHERE w.id = $2 AND w.status = 'active'`,
      [actor.id, wardId],
    );
    if (!wardAuth.rowCount) {
      throw new ForbiddenException("Guardian is not authorised for this ward");
    }

    const tagResult = await this.db.query<{
      id: string;
      code: string;
      inventory_status: string;
      holder_kind: string;
      activation_pin_hash: string | null;
      pin_failed_attempts: number;
      pin_locked_until: Date | null;
      pin_expires_at: Date | null;
    }>(
      `SELECT id, code, inventory_status, holder_kind, activation_pin_hash,
              pin_failed_attempts, pin_locked_until, pin_expires_at
       FROM tags
       WHERE upper(code) = upper($1)`,
      [normalizedCode],
    );

    const tag = tagResult.rows[0];

    // If tag not found, perform dummy bcrypt to mitigate timing discrepancies
    if (!tag) {
      await bcrypt.compare(normalizedPin, DUMMY_BCRYPT_HASH);
      throw new BadRequestException("Invalid tag code or activation PIN");
    }

    // If tag is locked due to repeated failures
    if (tag.pin_locked_until && new Date(tag.pin_locked_until) > new Date()) {
      await bcrypt.compare(normalizedPin, DUMMY_BCRYPT_HASH);
      throw new BadRequestException("Invalid tag code or activation PIN");
    }

    // If tag is expired, not blank, has no PIN hash, or not held by company/distributor
    const isExpired = tag.pin_expires_at && new Date(tag.pin_expires_at) <= new Date();
    const isEligible =
      tag.inventory_status === "blank" &&
      tag.activation_pin_hash !== null &&
      (tag.holder_kind === "company" || tag.holder_kind === "distributor") &&
      !isExpired;

    if (!isEligible) {
      await bcrypt.compare(normalizedPin, DUMMY_BCRYPT_HASH);
      throw new BadRequestException("Invalid tag code or activation PIN");
    }

    // Verify PIN
    const pinMatches = await bcrypt.compare(normalizedPin, tag.activation_pin_hash!);
    if (!pinMatches) {
      const nextFailed = tag.pin_failed_attempts + 1;
      let lockUntil: string | null = null;
      if (nextFailed >= 5) {
        const lockMinutes = 15 * Math.max(1, Math.floor(nextFailed / 5));
        lockUntil = `now() + interval '${lockMinutes} minutes'`;
      }

      if (lockUntil) {
        await this.db.query(
          `UPDATE tags
           SET pin_failed_attempts = $2, pin_locked_until = ${lockUntil}
           WHERE id = $1`,
          [tag.id, nextFailed],
        );
      } else {
        await this.db.query(`UPDATE tags SET pin_failed_attempts = $2 WHERE id = $1`, [
          tag.id,
          nextFailed,
        ]);
      }
      throw new BadRequestException("Invalid tag code or activation PIN");
    }

    // Successful Claim: run atomic transaction to transition blank -> assigned
    return this.db.transaction(async (client) => {
      const lockedTag = await client.query<{ id: string; inventory_status: string }>(
        `SELECT id, inventory_status FROM tags WHERE id = $1 FOR UPDATE`,
        [tag.id],
      );
      if (lockedTag.rows[0]?.inventory_status !== "blank") {
        throw new BadRequestException("Invalid tag code or activation PIN");
      }

      await client.query(
        `UPDATE tags
         SET inventory_status = 'assigned',
             ward_id = $2,
             holder_kind = 'guardian',
             holder_guardian_user_id = $3,
             holder_distributor_id = NULL,
             assigned_guardian_user_id = $3,
             assigned_by_user_id = $3,
             assigned_at = now(),
             status_changed_at = now(),
             activation_pin_hash = NULL,
             pin_failed_attempts = 0,
             pin_locked_until = NULL
         WHERE id = $1`,
        [tag.id, wardId, actor.id],
      );

      // Append single immutable 'assigned' tag_event
      await client.query(
        `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
         VALUES($1, 'assigned', $2, 'blank', 'assigned', jsonb_build_object('ward_id', $3::text, 'method', 'pin_claim'))`,
        [tag.id, actor.id, wardId],
      );

      return {
        success: true,
        code: tag.code,
        wardId,
      };
    });
  }

  async activateTag(
    actor: AuthenticatedUser,
    wardId: string,
    rawTagCode: string,
  ): Promise<{ success: true; code: string; status: "active"; activatedAt: Date }> {
    const normalizedCode = normalizeTagCode(rawTagCode);

    // 1. Verify guardian permissions over ward
    const wardAuth = await this.db.query<{
      id: string;
      can_manage_fields: boolean;
      can_manage_public_release: boolean;
    }>(
      `SELECT w.id, g.can_manage_fields, g.can_manage_public_release
       FROM wards w
       JOIN ward_guardians g ON g.ward_id = w.id AND g.user_id = $1 AND g.active = true
       WHERE w.id = $2 AND w.status = 'active'`,
      [actor.id, wardId],
    );
    const authRow = wardAuth.rows[0];
    if (!authRow) {
      throw new ForbiddenException("Guardian is not authorised for this ward");
    }
    if (!authRow.can_manage_public_release) {
      throw new ForbiddenException("Guardian lacks public-release authority for this ward");
    }

    // 2. Enforce safety gate: ward MUST have profile data present
    const dataCountResult = await this.db.query<{ count: string }>(
      `SELECT count(*)::text as count
       FROM ward_field_values
       WHERE ward_id = $1 AND value IS NOT NULL AND value::text NOT IN ('null', '""', '{}')`,
      [wardId],
    );
    const hasData = parseInt(dataCountResult.rows[0]?.count ?? "0", 10) > 0;
    if (!hasData) {
      throw new BadRequestException(
        "Cannot activate tag: ward profile has no data. Fill ward data before activation.",
      );
    }

    // 3. Enforce safety gate: at least one public-released approved field MUST have non-empty profile data
    const releasedDataCountResult = await this.db.query<{ count: string }>(
      `SELECT count(*)::text as count
       FROM ward_field_values v
       JOIN ward_field_visibility vis ON vis.ward_id = v.ward_id AND vis.field_catalog_id = v.field_catalog_id
       JOIN field_catalog f ON f.id = v.field_catalog_id
       WHERE v.ward_id = $1
         AND v.value IS NOT NULL AND v.value::text NOT IN ('null', '""', '{}')
         AND vis.visibility = 'public'
         AND f.approved = true
         AND f.public_eligible = true
         AND f.max_level = 'public'`,
      [wardId],
    );
    const hasReleasedData = parseInt(releasedDataCountResult.rows[0]?.count ?? "0", 10) > 0;
    if (!hasReleasedData) {
      throw new BadRequestException(
        "Cannot activate tag: no public-released field contains profile data. Fill data for a released field before activation.",
      );
    }

    // 4. Verify tag exists and is currently in 'assigned' state for this ward and guardian
    const tagResult = await this.db.query<{
      id: string;
      code: string;
      inventory_status: string;
      status: string;
      holder_kind: string;
      holder_guardian_user_id: string | null;
      ward_id: string | null;
      activated_at: Date | null;
    }>(
      `SELECT id, code, inventory_status, status, holder_kind, holder_guardian_user_id, ward_id, activated_at
       FROM tags
       WHERE upper(code) = upper($1)`,
      [normalizedCode],
    );
    const tag = tagResult.rows[0];
    if (!tag) {
      throw new NotFoundException("Tag not found");
    }
    if (
      tag.ward_id !== wardId ||
      tag.holder_kind !== "guardian" ||
      tag.holder_guardian_user_id !== actor.id
    ) {
      throw new ForbiddenException("Guardian does not hold custody of this tag for this ward");
    }

    // Idempotent if already active
    if (tag.inventory_status === "active" && tag.status === "active") {
      return {
        success: true,
        code: tag.code,
        status: "active",
        activatedAt: tag.activated_at ?? new Date(),
      };
    }

    if (tag.inventory_status !== "assigned") {
      throw new BadRequestException(`Tag cannot be activated from status ${tag.inventory_status}`);
    }

    // 5. Execute atomic activation transaction
    return this.db.transaction(async (client) => {
      const locked = await client.query<{
        id: string;
        inventory_status: string;
        status: string;
        activated_at: Date | null;
      }>(`SELECT id, inventory_status, status, activated_at FROM tags WHERE id = $1 FOR UPDATE`, [
        tag.id,
      ]);
      const currentLocked = locked.rows[0];
      if (currentLocked?.inventory_status === "active") {
        return {
          success: true,
          code: tag.code,
          status: "active",
          activatedAt: currentLocked.activated_at ?? new Date(),
        };
      }
      if (currentLocked?.inventory_status !== "assigned") {
        throw new BadRequestException(
          `Tag cannot be activated from status ${currentLocked?.inventory_status}`,
        );
      }

      const updateRes = await client.query<{ activated_at: Date }>(
        `UPDATE tags
         SET inventory_status = 'active',
             status = 'active',
             activated_at = COALESCE(activated_at, now()),
             status_changed_at = now()
         WHERE id = $1
         RETURNING activated_at`,
        [tag.id],
      );

      const activatedAt = updateRes.rows[0]?.activated_at ?? new Date();

      // Append immutable 'activated' event to tag_events
      await client.query(
        `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status, metadata)
         VALUES($1, 'activated', $2, 'assigned', 'active', jsonb_build_object('ward_id', $3::text, 'method', 'guardian_release'))`,
        [tag.id, actor.id, wardId],
      );

      return {
        success: true,
        code: tag.code,
        status: "active",
        activatedAt,
      };
    });
  }
}
