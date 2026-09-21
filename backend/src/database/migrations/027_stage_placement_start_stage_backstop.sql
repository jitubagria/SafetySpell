-- Stage tracking Step 3: one-time admin placement at a configured route start.
-- Extends, rather than bypasses, the migration-025 paired-event constraint.

ALTER TYPE tag_event_type ADD VALUE IF NOT EXISTS 'stage_placed';

-- Migration 024's structural pair check predates initial placement. Keep its
-- two-stage move rule and add only the null-source placement shape; the trigger
-- below supplies the stronger event-type, route-start, actor, and tenant rules.
ALTER TABLE tag_events DROP CONSTRAINT tag_events_stage_pair_check;
ALTER TABLE tag_events
  ADD CONSTRAINT tag_events_stage_pair_check
  CHECK (
    (from_stage_id IS NULL AND to_stage_id IS NULL)
    OR (from_stage_id IS NOT NULL AND to_stage_id IS NOT NULL AND from_stage_id <> to_stage_id)
    OR (from_stage_id IS NULL AND to_stage_id IS NOT NULL AND event_type::text = 'stage_placed')
  );

ALTER TABLE routes ADD COLUMN start_stage_id uuid;
ALTER TABLE routes
  ADD CONSTRAINT routes_start_stage_tenant_fk
  FOREIGN KEY (start_stage_id, id, tenant_id)
  REFERENCES stages(id, route_id, tenant_id) ON DELETE RESTRICT;

-- Both placement and movement events receive the transaction identifier used by
-- the deferred tags.current_stage_id pairing constraint.
CREATE OR REPLACE FUNCTION stamp_stage_moved_tag_event_transaction() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type::text IN ('stage_moved', 'stage_placed') THEN
    NEW.transaction_xid := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Preserve the existing stage_moved validation and add a deliberately narrow
-- stage_placed case: no from stage, unchanged lifecycle, active same-tenant
-- actor/tag/stage, and the destination must be that route's configured start.
CREATE OR REPLACE FUNCTION validate_stage_moved_tag_event() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type::text IN ('stage_moved', 'stage_placed') THEN
    IF NEW.to_stage_id IS NULL
       OR NEW.actor_user_id IS NULL
       OR NEW.from_status IS NULL
       OR NEW.to_status IS NULL THEN
      RAISE EXCEPTION 'stage events require destination, actor, and lifecycle status';
    END IF;

    IF NEW.event_type::text = 'stage_moved' AND NEW.from_stage_id IS NULL THEN
      RAISE EXCEPTION 'stage_moved events require a source stage';
    END IF;
    IF NEW.event_type::text = 'stage_placed' AND NEW.from_stage_id IS NOT NULL THEN
      RAISE EXCEPTION 'stage_placed events must have no source stage';
    END IF;
    IF NEW.from_status IS DISTINCT FROM NEW.to_status THEN
      RAISE EXCEPTION 'stage events must not change inventory lifecycle status';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM tags tag
      JOIN stages to_stage
        ON to_stage.id = NEW.to_stage_id
       AND to_stage.tenant_id = tag.tenant_id
       AND to_stage.active = true
      JOIN users actor
        ON actor.id = NEW.actor_user_id
       AND actor.tenant_id = tag.tenant_id
       AND actor.status = 'active'
      WHERE tag.id = NEW.tag_id
        AND tag.current_stage_id = NEW.to_stage_id
        AND tag.inventory_status = NEW.to_status
        AND (
          (NEW.event_type::text = 'stage_moved' AND EXISTS (
            SELECT 1 FROM stages from_stage
            WHERE from_stage.id = NEW.from_stage_id
              AND from_stage.tenant_id = tag.tenant_id
              AND from_stage.route_id = to_stage.route_id
              AND from_stage.active = true
          ))
          OR
          (NEW.event_type::text = 'stage_placed' AND EXISTS (
            SELECT 1 FROM routes route
            WHERE route.id = to_stage.route_id
              AND route.tenant_id = tag.tenant_id
              AND route.active = true
              AND route.start_stage_id = NEW.to_stage_id
          ))
        )
    ) THEN
      RAISE EXCEPTION 'stage event must use an active same-tenant actor, tag, and permitted route stage';
    END IF;
  ELSIF NEW.from_stage_id IS NOT NULL OR NEW.to_stage_id IS NOT NULL THEN
    RAISE EXCEPTION 'only stage_moved or stage_placed events may carry stage references';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A stage change remains impossible without the matching event in the same
-- transaction. NULL -> start stage is now the one explicit placement case;
-- stage -> NULL remains forbidden, and placed -> placed remains stage_moved.
CREATE OR REPLACE FUNCTION enforce_tag_stage_change_event() RETURNS trigger AS $$
DECLARE
  required_event_type text;
BEGIN
  IF OLD.current_stage_id IS NOT DISTINCT FROM NEW.current_stage_id THEN
    RETURN NULL;
  END IF;
  IF NEW.current_stage_id IS NULL THEN
    RAISE EXCEPTION 'stage -> NULL transitions are not permitted';
  END IF;

  required_event_type := CASE WHEN OLD.current_stage_id IS NULL THEN 'stage_placed' ELSE 'stage_moved' END;
  IF NOT EXISTS (
    SELECT 1
    FROM tag_events
    WHERE tag_id = NEW.id
      AND event_type::text = required_event_type
      AND from_stage_id IS NOT DISTINCT FROM OLD.current_stage_id
      AND to_stage_id = NEW.current_stage_id
      AND transaction_xid = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'stage change on tag % requires a matching % event in the same transaction',
      NEW.id, required_event_type;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
