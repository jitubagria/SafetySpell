-- Public free text remains fail-closed. `condition_notes` is the second deliberate
-- bounded-text exception alongside `allergy`; no other text field may be public-capable.

ALTER TABLE field_catalog DROP CONSTRAINT IF EXISTS field_catalog_public_controlled_values;

ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_public_controlled_values
  CHECK (
    NOT public_eligible OR (
      (data_type IN ('enum', 'boolean')
        AND jsonb_typeof(validation_policy->'allowed_values') = 'array'
        AND jsonb_array_length(validation_policy->'allowed_values') > 0)
      OR
      (field_key IN ('allergy', 'condition_notes')
        AND data_type IN ('text', 'short_text')
        AND jsonb_typeof(validation_policy->'max_length') = 'number')
    )
  );

-- The catalog row was seeded private in 018 so the old fail-closed constraint
-- remained valid while migrations were in progress. It becomes public-capable
-- only after this explicit allowlist has been installed; ward visibility stays
-- private until the guardian releases a value.
UPDATE field_catalog
  SET max_level = 'public',
      public_eligible = true,
      approved = true
  WHERE category = 'medical' AND field_key = 'condition_notes';
