-- Medical condition fields are guardian-editable and private until an authorised
-- guardian explicitly releases them. `condition_flags` is a controlled multi-select
-- enum set: selected keys are true, omitted keys are false. It is not free text.

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
VALUES
  (
    'medical',
    'condition_flags',
    'Condition flags',
    'enum',
    'public',
    true,
    true,
    true,
    true,
    '{"allowed_values":["epilepsy","cardiac","diabetes","blood_thinner","dialysis","pacemaker_implant","severe_allergy","asthma_copd","non_verbal","hearing_impaired","vision_impaired","wandering"],"multi_select":true}'::jsonb
  ),
  (
    'medical',
    'condition_notes',
    'Condition notes',
    'text',
    'private',
    false,
    false,
    true,
    true,
    '{"max_length":1000}'::jsonb
  )
ON CONFLICT (category, field_key) DO NOTHING;
