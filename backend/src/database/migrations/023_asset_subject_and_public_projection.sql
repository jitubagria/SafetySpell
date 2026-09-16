-- Step 5: tenant-owned plain-asset subjects. Assets intentionally have no
-- guardian, ward, profile, or consent relationship. Their public data is a
-- separate, explicit release list and is never inferred from free text.

INSERT INTO categories(key, name, color, kind)
VALUES ('asset', 'Asset', '#475569', 'plain_asset')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  label text,
  asset_type text,
  return_reference text,
  internal_note text,
  public_field_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  public_policy_version integer NOT NULL DEFAULT 1 CHECK (public_policy_version > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, category_id),
  CHECK (public_field_keys <@ ARRAY['label', 'asset_type', 'return_reference']::text[])
);

ALTER TABLE tags ADD COLUMN asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_asset_tenant_fk
  FOREIGN KEY (asset_id, tenant_id) REFERENCES assets(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_asset_category_fk
  FOREIGN KEY (asset_id, category_id) REFERENCES assets(id, category_id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_one_subject_at_most
  CHECK (num_nonnulls(ward_id, asset_id) <= 1);

CREATE OR REPLACE FUNCTION require_plain_asset_category() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM categories
    WHERE id = NEW.category_id AND kind = 'plain_asset' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'assets require an active plain_asset category';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_plain_category_only
BEFORE INSERT OR UPDATE OF category_id ON assets
FOR EACH ROW EXECUTE FUNCTION require_plain_asset_category();

CREATE TRIGGER assets_tenant_no_update
BEFORE UPDATE OF tenant_id ON assets
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

CREATE OR REPLACE FUNCTION asset_has_released_public_value(asset_uuid uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = asset_uuid
      AND (
        ('label' = ANY(a.public_field_keys) AND NULLIF(btrim(a.label), '') IS NOT NULL)
        OR ('asset_type' = ANY(a.public_field_keys) AND NULLIF(btrim(a.asset_type), '') IS NOT NULL)
        OR ('return_reference' = ANY(a.public_field_keys) AND NULLIF(btrim(a.return_reference), '') IS NOT NULL)
      )
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION prevent_empty_active_asset_tag() RETURNS trigger AS $$
BEGIN
  IF NEW.inventory_status = 'active' AND NEW.asset_id IS NOT NULL
     AND NOT asset_has_released_public_value(NEW.asset_id) THEN
    RAISE EXCEPTION 'active asset tags require a released allowlisted asset field with a value';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tags_active_asset_requires_public_value
BEFORE INSERT OR UPDATE OF inventory_status, asset_id ON tags
FOR EACH ROW EXECUTE FUNCTION prevent_empty_active_asset_tag();

CREATE OR REPLACE FUNCTION prevent_empty_active_asset_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tags WHERE asset_id = NEW.id AND inventory_status = 'active')
     AND NOT (
       ('label' = ANY(NEW.public_field_keys) AND NULLIF(btrim(NEW.label), '') IS NOT NULL)
       OR ('asset_type' = ANY(NEW.public_field_keys) AND NULLIF(btrim(NEW.asset_type), '') IS NOT NULL)
       OR ('return_reference' = ANY(NEW.public_field_keys) AND NULLIF(btrim(NEW.return_reference), '') IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'an active asset tag requires a released allowlisted asset field with a value';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_active_projection_not_empty
BEFORE UPDATE OF label, asset_type, return_reference, public_field_keys ON assets
FOR EACH ROW EXECUTE FUNCTION prevent_empty_active_asset_projection();

CREATE INDEX assets_tenant_id_idx ON assets(tenant_id);
CREATE INDEX tags_asset_id_idx ON tags(asset_id) WHERE asset_id IS NOT NULL;

-- Migration 016 intentionally did not grant future table privileges. The runtime
-- role needs ordinary asset operations but never destructive authority.
GRANT SELECT, INSERT, UPDATE ON assets TO safetyspell_app;
REVOKE DELETE, TRUNCATE ON assets FROM safetyspell_app;
