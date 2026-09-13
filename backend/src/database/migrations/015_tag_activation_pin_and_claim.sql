-- Migration 015: Tag activation PIN and claim foundation.
-- Blank tags carry a hashed activation PIN that is consumed (cleared) upon
-- assignment to a ward. Failed attempts are tracked and rate-locked.

ALTER TABLE tags
  ADD COLUMN activation_pin_hash text,
  ADD COLUMN pin_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until timestamptz,
  ADD COLUMN pin_expires_at timestamptz;

ALTER TABLE tags ADD CONSTRAINT tags_pin_failed_attempts_non_negative
  CHECK (pin_failed_attempts >= 0);

ALTER TABLE tags ADD CONSTRAINT tags_pin_claimed_consistency
  CHECK (inventory_status = 'blank' OR activation_pin_hash IS NULL);
