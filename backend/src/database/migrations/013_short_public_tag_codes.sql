-- Printed public codes are SS-XXXX-XXXX: seven Crockford Base32 payload
-- characters and one lightweight checksum. Existing long codes remain valid
-- so already manufactured stock continues to resolve.
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_code_check;
ALTER TABLE tags ADD CONSTRAINT tags_code_format_check CHECK (
  code ~ '^SS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'
  OR length(code) >= 16
);
CREATE UNIQUE INDEX tags_code_upper_unique_idx ON tags (upper(code));

CREATE OR REPLACE FUNCTION prevent_tag_code_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.code IS DISTINCT FROM NEW.code THEN
    RAISE EXCEPTION 'tag codes are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tags_code_no_update BEFORE UPDATE OF code ON tags
FOR EACH ROW EXECUTE FUNCTION prevent_tag_code_mutation();
