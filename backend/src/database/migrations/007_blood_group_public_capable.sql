-- Owner/policy decision: blood_group is public-capable. It is a controlled enum
-- (fixed allowed values), so it satisfies the public controlled-values gate. As with
-- allergy, approval is an owner/policy clearance with no clinical-reviewer attribution
-- (approved_by/approved_at stay NULL together). Each ward still stays private until its
-- guardian explicitly toggles visibility to public.
UPDATE field_catalog
  SET approved = true,
      public_eligible = true,
      max_level = 'public'
  WHERE field_key = 'blood_group';
