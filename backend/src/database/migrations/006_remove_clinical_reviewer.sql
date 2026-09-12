-- Owner-locked product decision: the clinical_reviewer role is removed from the product.
-- There is no clinical approval step and no clinician-verified provenance. Fields become
-- public-capable by catalog policy (approved/public_eligible set by migration/seed), and a
-- guardian releases them; every value is family-reported.

-- 1. Detach any catalog approval that pointed at a reviewer. `approved` stays true
--    (owner/policy clearance); the human-approver audit columns become NULL together.
UPDATE field_catalog
  SET approved_by = NULL, approved_at = NULL
  WHERE approved_by IN (SELECT id FROM users WHERE role = 'clinical_reviewer');

-- 2. Any values a reviewer had verified revert to family-reported.
UPDATE ward_field_values
  SET provenance = 'guardian_reported', verified_by = NULL, verified_at = NULL, verification_note = NULL
  WHERE provenance = 'clinician_verified'
     OR verified_by IN (SELECT id FROM users WHERE role = 'clinical_reviewer');

-- 3. Remove reviewer accounts.
DELETE FROM users WHERE role = 'clinical_reviewer';

-- 4. Drop the clinician-verification storage and its old pairing constraint.
ALTER TABLE ward_field_values DROP CONSTRAINT IF EXISTS ward_field_values_check;
ALTER TABLE ward_field_values DROP COLUMN IF EXISTS verified_by;
ALTER TABLE ward_field_values DROP COLUMN IF EXISTS verified_at;
ALTER TABLE ward_field_values DROP COLUMN IF EXISTS verification_note;

-- 5. Pin provenance to family-reported so clinician_verified can never be stored again.
--    (The provenance enum type keeps its dormant value; this check makes it unusable.)
ALTER TABLE ward_field_values
  ADD CONSTRAINT ward_field_values_family_reported
  CHECK (provenance = 'guardian_reported');
