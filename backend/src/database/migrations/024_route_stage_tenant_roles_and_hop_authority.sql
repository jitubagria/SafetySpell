-- Step 6 Slice 1: tenant-defined role names with fixed safety authority classes.
-- Route/stage position remains separate from tags.inventory_status.
-- Staff acts on company-held tags; staff is never a tag holder.

CREATE TYPE tenant_role_authority_class AS ENUM (
  'unprivileged',
  'operational_staff',
  'guardian',
  'admin'
);

CREATE TABLE tenant_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  authority_class tenant_role_authority_class NOT NULL DEFAULT 'unprivileged',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX tenant_roles_tenant_name_ci_unique
  ON tenant_roles(tenant_id, lower(name));
CREATE INDEX tenant_roles_tenant_id_idx ON tenant_roles(tenant_id);
CREATE INDEX tenant_roles_active_class_idx
  ON tenant_roles(tenant_id, authority_class)
  WHERE active;

-- Existing users retain their coarse system role. This nullable relation adds
-- a tenant-local, client-named role without introducing multi-tenant membership.
ALTER TABLE users ADD COLUMN tenant_role_id uuid;
ALTER TABLE users
  ADD CONSTRAINT users_tenant_role_tenant_fk
  FOREIGN KEY (tenant_role_id, tenant_id)
  REFERENCES tenant_roles(id, tenant_id) ON DELETE RESTRICT;

CREATE INDEX users_tenant_role_id_idx
  ON users(tenant_role_id) WHERE tenant_role_id IS NOT NULL;

-- Elevated tenant-role classes must agree with the existing coarse role.
-- Unprivileged labels may be assigned to any coarse role but grant no stage authority.
CREATE OR REPLACE FUNCTION enforce_user_tenant_role_class() RETURNS trigger AS $$
DECLARE
  role_class tenant_role_authority_class;
BEGIN
  IF NEW.tenant_role_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT authority_class INTO role_class
  FROM tenant_roles
  WHERE id = NEW.tenant_role_id AND tenant_id = NEW.tenant_id;

  IF role_class IS NULL THEN
    RAISE EXCEPTION 'tenant role must belong to the user tenant';
  END IF;

  IF role_class = 'operational_staff' AND NEW.role <> 'staff' THEN
    RAISE EXCEPTION 'operational_staff tenant roles require users.role = staff';
  END IF;
  IF role_class = 'guardian' AND NEW.role <> 'guardian' THEN
    RAISE EXCEPTION 'guardian tenant roles require users.role = guardian';
  END IF;
  IF role_class = 'admin' AND NEW.role <> 'company_admin' THEN
    RAISE EXCEPTION 'admin tenant roles require users.role = company_admin';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_tenant_role_class_guard
BEFORE INSERT OR UPDATE OF tenant_role_id, tenant_id, role ON users
FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_role_class();

CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, name)
);

CREATE INDEX routes_tenant_id_idx ON routes(tenant_id);

CREATE TABLE stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  route_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, route_id, tenant_id),
  UNIQUE (route_id, name),
  FOREIGN KEY (route_id, tenant_id)
    REFERENCES routes(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX stages_tenant_route_idx ON stages(tenant_id, route_id);

-- Existing tags and unplaced stock remain NULL until an owner-side placement.
ALTER TABLE tags ADD COLUMN current_stage_id uuid;
ALTER TABLE tags
  ADD CONSTRAINT tags_current_stage_tenant_fk
  FOREIGN KEY (current_stage_id, tenant_id)
  REFERENCES stages(id, tenant_id) ON DELETE RESTRICT;

CREATE INDEX tags_current_stage_id_idx
  ON tags(current_stage_id) WHERE current_stage_id IS NOT NULL;

-- A policy row narrows authority; it never overrides the custody lock.
-- Slice 2 admits only active operational_staff on company-held tags.
CREATE TABLE route_stage_hop_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  route_id uuid NOT NULL,
  from_stage_id uuid NOT NULL,
  to_stage_id uuid NOT NULL,
  allowed_tenant_role_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_stage_id <> to_stage_id),
  FOREIGN KEY (route_id, tenant_id)
    REFERENCES routes(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_stage_id, route_id, tenant_id)
    REFERENCES stages(id, route_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_stage_id, route_id, tenant_id)
    REFERENCES stages(id, route_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (allowed_tenant_role_id, tenant_id)
    REFERENCES tenant_roles(id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX route_stage_hop_permissions_active_unique
  ON route_stage_hop_permissions(
    tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id
  )
  WHERE active;

CREATE INDEX route_stage_hop_permissions_lookup_idx
  ON route_stage_hop_permissions(
    tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id
  )
  WHERE active;

-- Existing tag_events remains the append-only history ledger. Actor and time
-- already exist there; stages are added as first-class queryable columns.
ALTER TABLE tag_events
  ADD COLUMN from_stage_id uuid,
  ADD COLUMN to_stage_id uuid;

ALTER TABLE tag_events
  ADD CONSTRAINT tag_events_from_stage_fk
  FOREIGN KEY (from_stage_id) REFERENCES stages(id) ON DELETE RESTRICT;
ALTER TABLE tag_events
  ADD CONSTRAINT tag_events_to_stage_fk
  FOREIGN KEY (to_stage_id) REFERENCES stages(id) ON DELETE RESTRICT;
ALTER TABLE tag_events
  ADD CONSTRAINT tag_events_stage_pair_check
  CHECK (
    (from_stage_id IS NULL AND to_stage_id IS NULL)
    OR (
      from_stage_id IS NOT NULL
      AND to_stage_id IS NOT NULL
      AND from_stage_id <> to_stage_id
    )
  );

-- migrate.ts encloses this whole file in one transaction. The later trigger
-- compares event_type as text, avoiding an unsafe same-transaction enum literal.
ALTER TYPE tag_event_type ADD VALUE IF NOT EXISTS 'stage_moved';

CREATE OR REPLACE FUNCTION validate_stage_moved_tag_event() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type::text = 'stage_moved' THEN
    IF NEW.from_stage_id IS NULL
       OR NEW.to_stage_id IS NULL
       OR NEW.actor_user_id IS NULL
       OR NEW.from_status IS NULL
       OR NEW.to_status IS NULL THEN
      RAISE EXCEPTION
        'stage_moved events require stages, actor, and unchanged lifecycle status';
    END IF;

    IF NEW.from_status IS DISTINCT FROM NEW.to_status THEN
      RAISE EXCEPTION 'stage_moved events must not change inventory lifecycle status';
    END IF;

    -- Slice 2 updates the locked tag position before inserting this event.
    IF NOT EXISTS (
      SELECT 1
      FROM tags tag
      JOIN stages from_stage
        ON from_stage.id = NEW.from_stage_id
       AND from_stage.tenant_id = tag.tenant_id
      JOIN stages to_stage
        ON to_stage.id = NEW.to_stage_id
       AND to_stage.tenant_id = tag.tenant_id
       AND to_stage.route_id = from_stage.route_id
      JOIN users actor
        ON actor.id = NEW.actor_user_id
       AND actor.tenant_id = tag.tenant_id
       AND actor.status = 'active'
      WHERE tag.id = NEW.tag_id
        AND tag.current_stage_id = NEW.to_stage_id
        AND tag.inventory_status = NEW.to_status
    ) THEN
      RAISE EXCEPTION
        'stage_moved event must use active same-tenant actor, tag, route, and stages';
    END IF;
  ELSIF NEW.from_stage_id IS NOT NULL OR NEW.to_stage_id IS NOT NULL THEN
    RAISE EXCEPTION 'only stage_moved events may carry stage references';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tag_events_validate_stage_moved
BEFORE INSERT ON tag_events
FOR EACH ROW EXECUTE FUNCTION validate_stage_moved_tag_event();

-- Mutable owner-side configuration; no destructive runtime authority.
GRANT SELECT, INSERT, UPDATE
  ON tenant_roles, routes, stages, route_stage_hop_permissions
  TO safetyspell_app;
REVOKE DELETE, TRUNCATE
  ON tenant_roles, routes, stages, route_stage_hop_permissions
  FROM safetyspell_app;

-- Existing grants already cover tags UPDATE and tag_events INSERT/SELECT.
-- Existing tag_events append-only triggers remain unchanged.
