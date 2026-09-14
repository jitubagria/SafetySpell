-- Public free text is a narrow, explicit exception. The generic bounded-text
-- rule introduced in 005 must not make later text fields public-capable merely
-- because a migration supplies a length bound.

ALTER TABLE field_catalog DROP CONSTRAINT IF EXISTS field_catalog_public_controlled_values;

ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_public_controlled_values
  CHECK (
    NOT public_eligible OR (
      (data_type IN ('enum', 'boolean')
        AND jsonb_typeof(validation_policy->'allowed_values') = 'array'
        AND jsonb_array_length(validation_policy->'allowed_values') > 0)
      OR
      (field_key = 'allergy'
        AND data_type IN ('text', 'short_text')
        AND jsonb_typeof(validation_policy->'max_length') = 'number')
    )
  );
