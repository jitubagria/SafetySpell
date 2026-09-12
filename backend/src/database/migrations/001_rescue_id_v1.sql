-- Rescue ID V1: public-only consent boundary. This migration intentionally
-- contains no responder, communication, location, commerce, or NFC security flow.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('company_admin', 'guardian', 'staff');
CREATE TYPE user_status AS ENUM ('active', 'disabled');
CREATE TYPE ward_status AS ENUM ('active', 'inactive');
CREATE TYPE visibility_level AS ENUM ('private', 'public', 'verified_emergency_responder');
CREATE TYPE provenance AS ENUM ('guardian_reported', 'clinician_verified');
CREATE TYPE tag_status AS ENUM ('manufactured', 'allocated', 'sold', 'active', 'lost', 'revoked', 'transferred');
CREATE TYPE guidance_review_status AS ENUM ('draft', 'approved', 'published', 'expired', 'retired');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('elderly', 'kids', 'deaf_mute', 'disability', 'epilepsy_cardiac', 'medical')),
  name text NOT NULL,
  photo_url text,
  age smallint CHECK (age >= 0 AND age <= 130),
  language text,
  status ward_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ward_guardians (
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  relationship text NOT NULL,
  authority_basis text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  can_manage_fields boolean NOT NULL DEFAULT false,
  can_manage_public_release boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ward_id, user_id)
);

CREATE TABLE field_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text', 'short_text', 'boolean', 'enum')),
  max_level visibility_level NOT NULL DEFAULT 'private',
  public_eligible boolean NOT NULL DEFAULT false,
  approved boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  provenance_required boolean NOT NULL DEFAULT true,
  catalog_version integer NOT NULL DEFAULT 1 CHECK (catalog_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, field_key),
  -- The enum reserves responder for a future reviewed migration. V1 cannot use it.
  CHECK (max_level IN ('private', 'public')),
  CHECK (NOT public_eligible OR (approved AND max_level = 'public')),
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE ward_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  field_catalog_id uuid NOT NULL REFERENCES field_catalog(id) ON DELETE RESTRICT,
  value jsonb NOT NULL,
  provenance provenance NOT NULL DEFAULT 'guardian_reported',
  verified_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  verification_note text,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ward_id, field_catalog_id),
  CHECK (
    (provenance = 'guardian_reported' AND verified_by IS NULL AND verified_at IS NULL)
    OR (provenance = 'clinician_verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);

CREATE TABLE ward_field_visibility (
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  field_catalog_id uuid NOT NULL REFERENCES field_catalog(id) ON DELETE RESTRICT,
  visibility visibility_level NOT NULL DEFAULT 'private',
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ward_id, field_catalog_id),
  CHECK (visibility IN ('private', 'public'))
);

CREATE TABLE consent_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  field_catalog_id uuid REFERENCES field_catalog(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('visibility_changed', 'public_release_withdrawn')),
  old_visibility visibility_level,
  new_visibility visibility_level,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (old_visibility IS NULL OR old_visibility IN ('private', 'public')),
  CHECK (new_visibility IS NULL OR new_visibility IN ('private', 'public'))
);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) >= 16),
  ward_id uuid REFERENCES wards(id) ON DELETE RESTRICT,
  category text NOT NULL,
  nfc_uid text,
  form text NOT NULL CHECK (form IN ('band', 'sticker', 'card', 'nfc_band', 'plate')),
  status tag_status NOT NULL DEFAULT 'manufactured',
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tags_active_code_idx ON tags (code) WHERE status = 'active';

CREATE TABLE scan_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL,
  shown_field_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanner_ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
  -- No health values, raw targets, latitude, longitude, or scanner location are stored here.
);

CREATE TABLE guidance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  condition_key text,
  review_status guidance_review_status NOT NULL DEFAULT 'draft',
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((review_status IN ('approved', 'published', 'expired', 'retired')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE guidance_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guidance_rule_id uuid NOT NULL REFERENCES guidance_rules(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  do_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  dont_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guidance_rule_id, version)
);

CREATE TABLE privacy_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  body_markdown text NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_guidance_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'guidance_rule_versions are immutable; create a new version';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER guidance_versions_no_update BEFORE UPDATE ON guidance_rule_versions FOR EACH ROW EXECUTE FUNCTION prevent_guidance_version_mutation();
CREATE TRIGGER guidance_versions_no_delete BEFORE DELETE ON guidance_rule_versions FOR EACH ROW EXECUTE FUNCTION prevent_guidance_version_mutation();

CREATE OR REPLACE FUNCTION prevent_consent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_audit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consent_audit_no_update BEFORE UPDATE ON consent_audit FOR EACH ROW EXECUTE FUNCTION prevent_consent_audit_mutation();
CREATE TRIGGER consent_audit_no_delete BEFORE DELETE ON consent_audit FOR EACH ROW EXECUTE FUNCTION prevent_consent_audit_mutation();

-- Every seed remains draft/unapproved and is therefore impossible to release publicly.
INSERT INTO field_catalog (category, field_key, label, data_type, max_level, public_eligible, approved, provenance_required)
VALUES
  ('medical', 'blood_group', 'Blood group', 'short_text', 'private', false, false, true),
  ('medical', 'allergy', 'Allergy', 'text', 'private', false, false, true),
  ('elderly', 'communication_needs', 'Communication needs', 'text', 'private', false, false, true),
  ('deaf_mute', 'communication_needs', 'Communication needs', 'text', 'private', false, false, true);
