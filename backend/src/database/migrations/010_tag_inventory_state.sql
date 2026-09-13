-- Canonical current lifecycle state lives on tags. Legacy tag_status remains for
-- compatibility with the existing scan resolver until its controlled cutover.
CREATE TYPE tag_inventory_status AS ENUM ('blank', 'assigned', 'active', 'lost', 'revoked');

ALTER TABLE tags
  ADD COLUMN inventory_status tag_inventory_status,
  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN source_distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT,
  ADD COLUMN holder_distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT,
  ADD COLUMN assigned_guardian_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN assigned_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN assignment_reference text UNIQUE;

UPDATE tags SET inventory_status = CASE status
  WHEN 'active' THEN 'active'::tag_inventory_status
  WHEN 'lost' THEN 'lost'::tag_inventory_status
  WHEN 'revoked' THEN 'revoked'::tag_inventory_status
  WHEN 'sold' THEN 'assigned'::tag_inventory_status
  ELSE 'blank'::tag_inventory_status
END;

UPDATE tags AS tag
SET assigned_guardian_user_id = guardian.user_id,
    assigned_at = COALESCE(tag.activated_at, tag.created_at)
FROM (
  SELECT DISTINCT ON (ward_id) ward_id, user_id
  FROM ward_guardians
  WHERE active = true
  ORDER BY ward_id, created_at
) AS guardian
WHERE tag.inventory_status IN ('assigned', 'active')
  AND tag.ward_id IS NOT NULL
  AND guardian.ward_id = tag.ward_id;

ALTER TABLE tags ALTER COLUMN inventory_status SET NOT NULL;
CREATE INDEX tags_inventory_scope_idx ON tags(inventory_status, holder_distributor_id, category_id);
CREATE INDEX tags_assignment_reference_idx ON tags(assignment_reference) WHERE assignment_reference IS NOT NULL;
