-- Scan logs are a safety ledger. Runtime-role revocation exists in 016; these
-- owner-independent triggers complete the append-only boundary.
CREATE OR REPLACE FUNCTION prevent_scan_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'scan_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scan_log_no_update
BEFORE UPDATE ON scan_log
FOR EACH ROW EXECUTE FUNCTION prevent_scan_log_mutation();

CREATE TRIGGER scan_log_no_delete
BEFORE DELETE ON scan_log
FOR EACH ROW EXECUTE FUNCTION prevent_scan_log_mutation();
