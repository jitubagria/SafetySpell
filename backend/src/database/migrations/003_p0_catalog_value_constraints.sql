-- Catalog policies make a field's stated data type enforceable at write time.
ALTER TABLE field_catalog
  ADD COLUMN IF NOT EXISTS validation_policy jsonb NOT NULL DEFAULT '{"max_length": 200}'::jsonb;

ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_validation_policy_object
  CHECK (jsonb_typeof(validation_policy) = 'object');

-- All text, including private-only text, must have a finite catalog-defined bound.
ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_text_bound
  CHECK (
    data_type NOT IN ('text', 'short_text') OR (
      jsonb_typeof(validation_policy->'max_length') = 'number'
      AND (validation_policy->>'max_length')::integer BETWEEN 1 AND 1000
    )
  );

-- Enum values must be governed. An unbounded enum is indistinguishable from free text.
ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_enum_allowed_values
  CHECK (
    data_type <> 'enum' OR (
      jsonb_typeof(validation_policy->'allowed_values') = 'array'
      AND jsonb_array_length(validation_policy->'allowed_values') > 0
    )
  );

-- Public fields are never free text. They must be controlled enum/boolean data
-- with an explicit non-empty allowed-values policy.
ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_public_controlled_values
  CHECK (
    NOT public_eligible OR (
      data_type IN ('enum', 'boolean')
      AND jsonb_typeof(validation_policy->'allowed_values') = 'array'
      AND jsonb_array_length(validation_policy->'allowed_values') > 0
    )
  );
