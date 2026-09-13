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
}
