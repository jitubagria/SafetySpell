-- Step 2: tenant ownership and normalized category integrity.
-- Runtime tenant predicates deliberately belong to Step 3. This migration supplies
-- the database ownership boundary without adding tenant snapshots to immutable ledgers.

-- V1 was a single-tenant system. A migration may deterministically map its existing
-- roots only when there are zero or one tenants; a multi-tenant partial backfill is
-- ambiguous and must stop rather than guess.
ALTER TABLE wards ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE tag_batches ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE ward_guardians ADD COLUMN tenant_id uuid;

DO $$
DECLARE
  tenant_count integer;
  fallback_tenant_id uuid;
BEGIN
  SELECT count(*) INTO tenant_count FROM tenants;

  IF tenant_count = 0 THEN
    INSERT INTO tenants (id, name, type, status)
    VALUES (
      '00000000-0000-4000-8000-000000000021',
      'SafetySpell legacy single-tenant',
      'business',
      'active'
    );
    fallback_tenant_id := '00000000-0000-4000-8000-000000000021';
  ELSIF tenant_count = 1 THEN
    SELECT id INTO fallback_tenant_id FROM tenants;
  ELSE
    RAISE EXCEPTION
      'tenant backfill is ambiguous: found % tenants; migrate roots only after assigning each root tenant explicitly',
      tenant_count;
  END IF;

  -- Existing V1 data had no tenant distinction. The single available tenant is the
  -- only deterministic mapping; any future multi-tenant database must be explicit.
  UPDATE users SET tenant_id = fallback_tenant_id WHERE tenant_id IS NULL;
  UPDATE wards SET tenant_id = fallback_tenant_id WHERE tenant_id IS NULL;
  UPDATE tags SET tenant_id = fallback_tenant_id WHERE tenant_id IS NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  fallback_tenant_id uuid;
BEGIN
  SELECT id INTO fallback_tenant_id FROM tenants;
  UPDATE tag_batches SET tenant_id = fallback_tenant_id WHERE tenant_id IS NULL;

  IF EXISTS (
    SELECT 1
    FROM tags tag
    JOIN tag_batches batch ON batch.id = tag.batch_id
    WHERE tag.tenant_id IS DISTINCT FROM batch.tenant_id
  ) THEN
    RAISE EXCEPTION
      'tenant backfill conflict: an existing tag and batch have different tenants; repair explicitly before migration';
  END IF;
END;
$$ LANGUAGE plpgsql;

UPDATE ward_guardians guardian
SET tenant_id = ward.tenant_id
FROM wards ward
WHERE ward.id = guardian.ward_id AND guardian.tenant_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ward_guardians guardian
    JOIN wards ward ON ward.id = guardian.ward_id
    JOIN users account ON account.id = guardian.user_id
    WHERE guardian.tenant_id IS DISTINCT FROM ward.tenant_id
       OR guardian.tenant_id IS DISTINCT FROM account.tenant_id
  ) THEN
    RAISE EXCEPTION
      'tenant backfill conflict: ward guardian, ward, and user must share one tenant';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- New writes keep the pre-Step-3 single-tenant runtime working. Step 3 replaces
-- these bridge defaults with server-derived tenant context before multi-tenant use.
DO $$
DECLARE
  fallback_tenant_id uuid;
BEGIN
  SELECT id INTO fallback_tenant_id FROM tenants;
  EXECUTE format('ALTER TABLE users ALTER COLUMN tenant_id SET DEFAULT %L::uuid', fallback_tenant_id);
  EXECUTE format('ALTER TABLE wards ALTER COLUMN tenant_id SET DEFAULT %L::uuid', fallback_tenant_id);
  EXECUTE format('ALTER TABLE tags ALTER COLUMN tenant_id SET DEFAULT %L::uuid', fallback_tenant_id);
  EXECUTE format('ALTER TABLE tag_batches ALTER COLUMN tenant_id SET DEFAULT %L::uuid', fallback_tenant_id);
  EXECUTE format('ALTER TABLE ward_guardians ALTER COLUMN tenant_id SET DEFAULT %L::uuid', fallback_tenant_id);
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE wards ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE tags ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE tag_batches ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE ward_guardians ALTER COLUMN tenant_id SET NOT NULL;

-- Normalise legacy category keys. Keep the key for compatible clients and current
-- non-tenant service queries, but bind every key/id pair to the global category master.
ALTER TABLE categories
  ADD COLUMN kind text NOT NULL DEFAULT 'consent_governed_person'
  CHECK (kind IN ('consent_governed_person', 'plain_asset'));
ALTER TABLE categories ADD CONSTRAINT categories_id_key_unique UNIQUE (id, key);

ALTER TABLE wards ADD COLUMN category_id uuid;
ALTER TABLE field_catalog ADD COLUMN category_id uuid;
UPDATE wards ward SET category_id = category.id FROM categories category WHERE category.key = ward.category;
UPDATE field_catalog field SET category_id = category.id FROM categories category WHERE category.key = field.category;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wards WHERE category_id IS NULL) THEN
    RAISE EXCEPTION 'category backfill failed: one or more wards use a category key absent from categories';
  END IF;
  IF EXISTS (SELECT 1 FROM field_catalog WHERE category_id IS NULL) THEN
    RAISE EXCEPTION 'category backfill failed: one or more field_catalog rows use a category key absent from categories';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tags tag
    JOIN categories category ON category.id = tag.category_id
    WHERE tag.category IS DISTINCT FROM category.key
  ) THEN
    RAISE EXCEPTION 'category backfill conflict: one or more tags have mismatched category key and category_id';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tags tag
    JOIN wards ward ON ward.id = tag.ward_id
    WHERE tag.category_id IS DISTINCT FROM ward.category_id
  ) THEN
    RAISE EXCEPTION 'category backfill conflict: one or more assigned tags do not match their ward category';
  END IF;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE wards ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE field_catalog ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE wards DROP CONSTRAINT IF EXISTS wards_category_check;

ALTER TABLE users ADD CONSTRAINT users_id_tenant_unique UNIQUE (id, tenant_id);
ALTER TABLE wards ADD CONSTRAINT wards_id_tenant_unique UNIQUE (id, tenant_id);
ALTER TABLE wards ADD CONSTRAINT wards_id_category_unique UNIQUE (id, category_id);
ALTER TABLE tag_batches ADD CONSTRAINT tag_batches_id_category_tenant_unique UNIQUE (id, category_id, tenant_id);

ALTER TABLE wards
  ADD CONSTRAINT wards_category_pair_fk
  FOREIGN KEY (category_id, category) REFERENCES categories(id, key) ON DELETE RESTRICT;
ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_category_pair_fk
  FOREIGN KEY (category_id, category) REFERENCES categories(id, key) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_category_pair_fk
  FOREIGN KEY (category_id, category) REFERENCES categories(id, key) ON DELETE RESTRICT;
ALTER TABLE ward_guardians
  ADD CONSTRAINT ward_guardians_ward_tenant_fk
  FOREIGN KEY (ward_id, tenant_id) REFERENCES wards(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE ward_guardians
  ADD CONSTRAINT ward_guardians_user_tenant_fk
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_ward_tenant_fk
  FOREIGN KEY (ward_id, tenant_id) REFERENCES wards(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_ward_category_fk
  FOREIGN KEY (ward_id, category_id) REFERENCES wards(id, category_id) ON DELETE RESTRICT;
ALTER TABLE tags
  ADD CONSTRAINT tags_batch_category_tenant_fk
  FOREIGN KEY (batch_id, category_id, tenant_id)
  REFERENCES tag_batches(id, category_id, tenant_id) ON DELETE RESTRICT;

-- During the compatibility window, existing V1 writes still provide a category key.
-- Resolve its normalized ID inside the database, then let the pair foreign keys above
-- reject any divergence. Step 3 may move callers to explicit category_id inputs.
CREATE OR REPLACE FUNCTION synchronize_category_id_from_key() RETURNS trigger AS $$
BEGIN
  SELECT id INTO NEW.category_id FROM categories WHERE key = NEW.category;
  IF NEW.category_id IS NULL THEN
    RAISE EXCEPTION '% category key is not present in categories: %', TG_TABLE_NAME, NEW.category;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wards_category_key_sync
BEFORE INSERT OR UPDATE OF category ON wards
FOR EACH ROW EXECUTE FUNCTION synchronize_category_id_from_key();
CREATE TRIGGER field_catalog_category_key_sync
BEFORE INSERT OR UPDATE OF category ON field_catalog
FOR EACH ROW EXECUTE FUNCTION synchronize_category_id_from_key();
CREATE TRIGGER tags_category_key_sync
BEFORE INSERT OR UPDATE OF category ON tags
FOR EACH ROW EXECUTE FUNCTION synchronize_category_id_from_key();

CREATE OR REPLACE FUNCTION prevent_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION '% tenant_id is immutable', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wards_tenant_no_update
BEFORE UPDATE OF tenant_id ON wards
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();
CREATE TRIGGER tags_tenant_no_update
BEFORE UPDATE OF tenant_id ON tags
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();
CREATE TRIGGER tag_batches_tenant_no_update
BEFORE UPDATE OF tenant_id ON tag_batches
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

-- Unknown/bad public scans have no real tag and belong to no tenant. They remain
-- append-only; tenant-scoped audit views use inner parent joins and exclude them.
ALTER TABLE scan_log ALTER COLUMN tag_id DROP NOT NULL;

CREATE INDEX users_tenant_id_idx ON users(tenant_id);
CREATE INDEX wards_tenant_id_idx ON wards(tenant_id);
CREATE INDEX tags_tenant_id_idx ON tags(tenant_id);
CREATE INDEX tag_batches_tenant_id_idx ON tag_batches(tenant_id);
CREATE INDEX ward_guardians_tenant_id_idx ON ward_guardians(tenant_id);
CREATE INDEX scan_log_tag_id_idx ON scan_log(tag_id);
CREATE INDEX consent_audit_ward_id_idx ON consent_audit(ward_id);

-- This is the single approved tenant-resolution path for ledger audit reads.
CREATE VIEW tenant_ledger_audit AS
SELECT
  'tag_event'::text AS ledger_type,
  event.id AS ledger_id,
  tag.tenant_id,
  event.tag_id AS parent_id,
  event.created_at
FROM tag_events event
JOIN tags tag ON tag.id = event.tag_id
UNION ALL
SELECT
  'scan_log'::text AS ledger_type,
  scan.id AS ledger_id,
  tag.tenant_id,
  scan.tag_id AS parent_id,
  scan.created_at
FROM scan_log scan
JOIN tags tag ON tag.id = scan.tag_id
UNION ALL
SELECT
  'consent_audit'::text AS ledger_type,
  audit.id AS ledger_id,
  ward.tenant_id,
  audit.ward_id AS parent_id,
  audit.created_at
FROM consent_audit audit
JOIN wards ward ON ward.id = audit.ward_id;

GRANT SELECT ON tenant_ledger_audit TO safetyspell_app;
