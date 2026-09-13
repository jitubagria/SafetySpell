-- Custody is the authority boundary. Current custody stays on tags; tag_events
-- is the immutable history. Reuse the distributor/source fields from migration
-- 010 rather than introducing a parallel allocation or ownership table.
CREATE TYPE tag_holder_kind AS ENUM ('company', 'distributor', 'guardian');

ALTER TABLE tags
  ADD COLUMN holder_kind tag_holder_kind,
  ADD COLUMN holder_guardian_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

-- Preserve origin before a stale distributor holder is cleared for a guardian.
UPDATE tags
SET source_distributor_id = holder_distributor_id
WHERE source_distributor_id IS NULL AND holder_distributor_id IS NOT NULL;

-- For assigned/active legacy tags, guardian custody wins over a stale distributor
-- holder. The assigned guardian is populated by migration 010; a current active
-- guardian relation is a deterministic fallback for older rows.
WITH active_guardian AS (
  SELECT DISTINCT ON (ward_id) ward_id, user_id
  FROM ward_guardians
  WHERE active = true
  ORDER BY ward_id, created_at
)
UPDATE tags AS tag
SET holder_kind = 'guardian',
    holder_guardian_user_id = COALESCE(tag.assigned_guardian_user_id, guardian.user_id),
    holder_distributor_id = NULL
FROM active_guardian AS guardian
WHERE tag.inventory_status IN ('assigned', 'active')
  AND tag.ward_id = guardian.ward_id;

-- Fail migration rather than silently relabelling an assigned/active tag with no
-- guardian authority as company stock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tags
    WHERE inventory_status IN ('assigned', 'active') AND holder_kind IS NULL
  ) THEN
    RAISE EXCEPTION 'assigned or active tag lacks a guardian custody record';
  END IF;
END;
$$ LANGUAGE plpgsql;

UPDATE tags
SET holder_kind = 'distributor',
    holder_guardian_user_id = NULL
WHERE holder_kind IS NULL AND holder_distributor_id IS NOT NULL;

UPDATE tags
SET holder_kind = 'company',
    holder_distributor_id = NULL,
    holder_guardian_user_id = NULL
WHERE holder_kind IS NULL;

ALTER TABLE tags ALTER COLUMN holder_kind SET NOT NULL;
ALTER TABLE tags ADD CONSTRAINT tags_holder_fk_consistency CHECK (
  (holder_kind = 'company' AND holder_distributor_id IS NULL AND holder_guardian_user_id IS NULL)
  OR (holder_kind = 'distributor' AND holder_distributor_id IS NOT NULL AND holder_guardian_user_id IS NULL)
  OR (holder_kind = 'guardian' AND holder_distributor_id IS NULL AND holder_guardian_user_id IS NOT NULL)
);
CREATE INDEX tags_holder_guardian_scope_idx ON tags(holder_kind, holder_guardian_user_id, category_id);
