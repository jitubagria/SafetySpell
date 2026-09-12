-- Applied after 001 so existing development databases gain the reviewer role safely.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'clinical_reviewer';

ALTER TABLE scan_log RENAME COLUMN scanner_ip_hash TO scanner_ip_hmac;

-- No data migration grants this role. A clinical reviewer must be explicitly assigned.
