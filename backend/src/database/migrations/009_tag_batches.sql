-- Admin-created tag batches. Tags remain the inventory source of truth; a batch is
-- manufacturing/print metadata and never contains ward or public-profile data.
CREATE TABLE tag_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code text NOT NULL UNIQUE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  form text NOT NULL CHECK (form IN ('band', 'sticker', 'card', 'nfc_band', 'plate')),
  quantity integer NOT NULL CHECK (quantity > 0),
  qr_design_version integer NOT NULL DEFAULT 1 CHECK (qr_design_version > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tags ADD COLUMN batch_id uuid REFERENCES tag_batches(id) ON DELETE RESTRICT;
ALTER TABLE tags ADD COLUMN category_id uuid REFERENCES categories(id) ON DELETE RESTRICT;
UPDATE tags AS tag SET category_id = category.id FROM categories AS category WHERE category.key = tag.category;
ALTER TABLE tags ALTER COLUMN category_id SET NOT NULL;
CREATE INDEX tags_batch_id_idx ON tags(batch_id);
