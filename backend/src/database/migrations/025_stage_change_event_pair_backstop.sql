-- Step 6 Slice 3: stage change and stage_moved event pair backstop.
-- Enforces that any tags.current_stage_id update is paired with a matching
-- stage_moved tag_event in the exact same transaction.
-- Forbids NULL->stage and stage->NULL transitions on UPDATE in this slice.

ALTER TABLE tag_events
  ADD COLUMN transaction_xid xid8;

CREATE INDEX tag_events_stage_moved_xid_idx
  ON tag_events(tag_id, transaction_xid)
  WHERE event_type = 'stage_moved';

-- Stamp each new stage_moved event with pg_current_xact_id() before insert.
-- Name sorts alphabetically before tag_events_validate_stage_moved ('s' before 'v').
CREATE OR REPLACE FUNCTION stamp_stage_moved_tag_event_transaction() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type::text = 'stage_moved' THEN
    NEW.transaction_xid := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tag_events_stage_moved_transaction_stamp
BEFORE INSERT ON tag_events
FOR EACH ROW EXECUTE FUNCTION stamp_stage_moved_tag_event_transaction();

-- Deferred constraint trigger validates that any stage update on tags is paired
-- with a matching stage_moved event in the same transaction.
CREATE OR REPLACE FUNCTION enforce_tag_stage_change_event() RETURNS trigger AS $$
BEGIN
  IF OLD.current_stage_id IS NOT DISTINCT FROM NEW.current_stage_id THEN
    RETURN NULL;
  END IF;

  -- Slice 2 only permits moves between placed stages.
  -- Initial placement (NULL -> stage) and unplacement (stage -> NULL) are forbidden on UPDATE.
  IF OLD.current_stage_id IS NULL OR NEW.current_stage_id IS NULL THEN
    RAISE EXCEPTION 'unplaced stage transitions (NULL->stage or stage->NULL) are not permitted in this slice';
  END IF;

  -- Check for a matching stage_moved event created in this exact same transaction.
  IF NOT EXISTS (
    SELECT 1
    FROM tag_events
    WHERE tag_id = NEW.id
      AND event_type::text = 'stage_moved'
      AND from_stage_id = OLD.current_stage_id
      AND to_stage_id = NEW.current_stage_id
      AND transaction_xid = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'stage change on tag % from % to % requires a matching stage_moved event in the same transaction',
      NEW.id, OLD.current_stage_id, NEW.current_stage_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER tags_stage_change_requires_event
AFTER UPDATE OF current_stage_id ON tags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_tag_stage_change_event();
