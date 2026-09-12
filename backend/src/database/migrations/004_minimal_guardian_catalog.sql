-- Minimal guardian surface. These fields are deliberately seeded as draft/private;
-- an explicitly assigned clinical_reviewer must approve each catalog row before a
-- guardian can make its value public.
ALTER TABLE field_catalog
  ADD COLUMN IF NOT EXISTS guardian_editable boolean NOT NULL DEFAULT false;

WITH categories(category) AS (
  VALUES
    ('elderly'),
    ('kids'),
    ('deaf_mute'),
    ('disability'),
    ('epilepsy_cardiac'),
    ('medical')
), fields(field_key, label, validation_policy) AS (
  VALUES
    ('age_band', 'Age band', '{"allowed_values":["child","teen","adult","senior"]}'::jsonb),
    ('primary_language', 'Primary language', '{"allowed_values":["hi","en"]}'::jsonb)
)
INSERT INTO field_catalog (
  category,
  field_key,
  label,
  data_type,
  max_level,
  public_eligible,
  approved,
  provenance_required,
  guardian_editable,
  validation_policy
)
SELECT
  categories.category,
  fields.field_key,
  fields.label,
  'enum',
  'private',
  false,
  false,
  true,
  true,
  fields.validation_policy
FROM categories
CROSS JOIN fields
ON CONFLICT (category, field_key) DO NOTHING;
