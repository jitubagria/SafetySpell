-- Migration 016: Database role hardening and append-only privilege enforcement.
-- Establishes the least-privilege runtime role (safetyspell_app) distinct from the
-- schema-owner migration role. Revokes UPDATE, DELETE, and TRUNCATE on audit/event tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safetyspell_app') THEN
    CREATE ROLE safetyspell_app WITH LOGIN PASSWORD 'safetyspell_app_password';
  END IF;
END $$;

-- Schema usage
GRANT USAGE ON SCHEMA public TO safetyspell_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO safetyspell_app;

-- Append-only audit and event logs: INSERT and SELECT ONLY
GRANT SELECT, INSERT ON tag_events, consent_audit, scan_log TO safetyspell_app;
REVOKE UPDATE, DELETE, TRUNCATE ON tag_events, consent_audit, scan_log FROM safetyspell_app;

-- Operational tables: CRUD needed for application lifecycle, TRUNCATE/DELETE forbidden on core entities
GRANT SELECT, INSERT, UPDATE ON tags, wards, ward_guardians, ward_field_values, ward_field_visibility, distributors, distributor_allowed_categories, tag_batches, tenants, users, categories, field_catalog, privacy_notices TO safetyspell_app;
GRANT DELETE ON ward_field_values, ward_field_visibility, ward_guardians TO safetyspell_app;
REVOKE TRUNCATE, DELETE ON tags, tag_batches, distributors, categories, field_catalog, users, tenants, privacy_notices FROM safetyspell_app;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO safetyspell_app;
