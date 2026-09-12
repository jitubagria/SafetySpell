-- Owner-locked product decision: the allergy field is public-capable FREE TEXT.
--
-- Public free text is now permitted, but only as BOUNDED PLAIN TEXT. Two controls
-- remain and are not optional:
--   1. Database bound: field_catalog_text_bound still caps every text field to a
--      catalog-defined max_length between 1 and 1000. That cap is unchanged.
--   2. Write-path lock (API): the guardian write path strips HTML, neutralises
--      clickable link schemes, and stores plain text only before persistence.
-- There is deliberately NO clinical-reviewer gate on allergy.
--
-- This migration only relaxes the "public fields must be a controlled enum/boolean"
-- rule to also admit bounded text/short_text. Every other public gate is untouched.

ALTER TABLE field_catalog DROP CONSTRAINT IF EXISTS field_catalog_public_controlled_values;

ALTER TABLE field_catalog
  ADD CONSTRAINT field_catalog_public_controlled_values
  CHECK (
    NOT public_eligible OR (
      (data_type IN ('enum', 'boolean')
        AND jsonb_typeof(validation_policy->'allowed_values') = 'array'
        AND jsonb_array_length(validation_policy->'allowed_values') > 0)
      OR
      (data_type IN ('text', 'short_text')
        AND jsonb_typeof(validation_policy->'max_length') = 'number')
    )
  );

-- blood_group becomes a guardian-editable controlled dropdown (private-capable only).
UPDATE field_catalog
  SET data_type = 'enum',
      guardian_editable = true,
      validation_policy = '{"allowed_values":["A+","A-","B+","B-","O+","O-","AB+","AB-","Unknown"]}'::jsonb
  WHERE field_key = 'blood_group';

-- allergy becomes guardian-editable, public-capable, bounded free text.
-- approved = true is an owner/policy clearance for public use; approved_by/approved_at are
-- deliberately left NULL because there is NO individual clinical-reviewer step for allergy.
-- (field_catalog_check1 permits both audit columns to be NULL together.)
UPDATE field_catalog
  SET data_type = 'text',
      guardian_editable = true,
      validation_policy = '{"max_length":1000}'::jsonb,
      public_eligible = true,
      max_level = 'public',
      approved = true
  WHERE field_key = 'allergy';
