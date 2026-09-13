-- Append-only operational history. Current custody/state remains on tags; this log records
-- who changed it and when without containing ward profile or health data.
CREATE TYPE tag_event_type AS ENUM ('created', 'allocated', 'assigned', 'activated', 'transferred', 'lost', 'revoked');
CREATE TABLE tag_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  event_type tag_event_type NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  from_status tag_inventory_status,
  to_status tag_inventory_status,
  assignment_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tag_events_tag_created_idx ON tag_events(tag_id, created_at DESC);
CREATE OR REPLACE FUNCTION prevent_tag_event_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'tag_events are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tag_events_no_update BEFORE UPDATE ON tag_events FOR EACH ROW EXECUTE FUNCTION prevent_tag_event_mutation();
CREATE TRIGGER tag_events_no_delete BEFORE DELETE ON tag_events FOR EACH ROW EXECUTE FUNCTION prevent_tag_event_mutation();
