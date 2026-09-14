-- inventory_status is the canonical five-state tag lifecycle. The retained status
-- column becomes a compatibility mirror with the same enum and no independent
-- write path. Do not remove it until its separate, approved retirement migration.

DO $$
DECLARE
  divergent_ids text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id)
  INTO divergent_ids
  FROM (
    SELECT id
    FROM tags
    WHERE inventory_status IS DISTINCT FROM CASE status
      WHEN 'active' THEN 'active'::tag_inventory_status
      WHEN 'lost' THEN 'lost'::tag_inventory_status
      WHEN 'revoked' THEN 'revoked'::tag_inventory_status
      WHEN 'sold' THEN 'assigned'::tag_inventory_status
      ELSE 'blank'::tag_inventory_status
    END
    ORDER BY id
    LIMIT 25
  ) AS divergent;

  IF divergent_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'tag lifecycle parity failed: tags.status and tags.inventory_status diverge for tag IDs [%]. Repair the named rows before migration 022; no lifecycle was changed',
      divergent_ids;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS tags_active_code_idx;

ALTER TABLE tags ALTER COLUMN status DROP DEFAULT;
ALTER TABLE tags
  ALTER COLUMN status TYPE tag_inventory_status
  USING CASE status
    WHEN 'active' THEN 'active'::tag_inventory_status
    WHEN 'lost' THEN 'lost'::tag_inventory_status
    WHEN 'revoked' THEN 'revoked'::tag_inventory_status
    WHEN 'sold' THEN 'assigned'::tag_inventory_status
    ELSE 'blank'::tag_inventory_status
  END;
ALTER TABLE tags ALTER COLUMN status SET DEFAULT 'blank';

CREATE OR REPLACE FUNCTION synchronize_legacy_tag_status() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := NEW.inventory_status;
    RETURN NEW;
  END IF;

  IF NEW.inventory_status IS DISTINCT FROM OLD.inventory_status THEN
    NEW.status := NEW.inventory_status;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'tags.status is a read-only mirror of tags.inventory_status; update inventory_status instead';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tags_status_mirror_from_inventory
BEFORE INSERT OR UPDATE OF inventory_status, status ON tags
FOR EACH ROW EXECUTE FUNCTION synchronize_legacy_tag_status();

CREATE INDEX tags_active_code_idx ON tags (code) WHERE inventory_status = 'active';
