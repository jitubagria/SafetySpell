-- Stage tracking Step 1: tenant-bound operational units and view scopes.
-- This migration deliberately has no public resolver, ward, guardian, or consent contact.

CREATE TYPE role_view_scope_kind AS ENUM ('own_stage', 'unit', 'tenant');
CREATE TYPE role_view_scope_audit_event AS ENUM ('granted', 'revoked');

CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, name)
);

CREATE TRIGGER units_tenant_no_update
BEFORE UPDATE OF tenant_id ON units
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

-- A stage may be assigned to one generic tenant unit. The name intentionally
-- avoids a healthcare-specific meaning such as "department" or "ward".
ALTER TABLE stages ADD COLUMN unit_id uuid;
ALTER TABLE stages
  ADD CONSTRAINT stages_unit_tenant_fk
  FOREIGN KEY (unit_id, tenant_id) REFERENCES units(id, tenant_id) ON DELETE RESTRICT;
CREATE INDEX stages_unit_id_idx ON stages(unit_id) WHERE unit_id IS NOT NULL;

CREATE TABLE role_view_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_role_id uuid NOT NULL,
  scope_kind role_view_scope_kind NOT NULL,
  stage_id uuid,
  unit_id uuid,
  active boolean NOT NULL DEFAULT true,
  granted_by_user_id uuid NOT NULL,
  revoked_by_user_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (tenant_role_id, tenant_id)
    REFERENCES tenant_roles(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (stage_id, tenant_id)
    REFERENCES stages(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, tenant_id)
    REFERENCES units(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (granted_by_user_id, tenant_id)
    REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by_user_id, tenant_id)
    REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (scope_kind = 'own_stage' AND stage_id IS NOT NULL AND unit_id IS NULL)
    OR (scope_kind = 'unit' AND unit_id IS NOT NULL AND stage_id IS NULL)
    OR (scope_kind = 'tenant' AND stage_id IS NULL AND unit_id IS NULL)
  ),
  CHECK (
    (active = true AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
    OR (active = false AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX role_view_scopes_active_role_unique
  ON role_view_scopes(tenant_role_id) WHERE active;
CREATE INDEX role_view_scopes_tenant_role_idx
  ON role_view_scopes(tenant_id, tenant_role_id) WHERE active;

-- Only operational staff and tenant-admin roles participate in this wire.
CREATE OR REPLACE FUNCTION validate_operational_role_view_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenant_roles role
    WHERE role.id = NEW.tenant_role_id
      AND role.tenant_id = NEW.tenant_id
      AND role.authority_class IN ('operational_staff', 'admin')
  ) THEN
    RAISE EXCEPTION 'role_view_scopes require an operational_staff or admin tenant role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_view_scopes_operational_role_check
BEFORE INSERT OR UPDATE OF tenant_role_id, tenant_id ON role_view_scopes
FOR EACH ROW EXECUTE FUNCTION validate_operational_role_view_scope();

-- Scope grants are immutable policy records. Revoke by deactivation; create a
-- new row to grant again. This keeps the accompanying audit ledger truthful.
CREATE OR REPLACE FUNCTION prevent_role_view_scope_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'role_view_scopes tenant_id is immutable';
  END IF;
  IF NEW.tenant_role_id IS DISTINCT FROM OLD.tenant_role_id
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id THEN
    RAISE EXCEPTION 'role_view_scopes grants are immutable; revoke and create a new grant';
  END IF;
  IF OLD.active = false OR NEW.active = true THEN
    RAISE EXCEPTION 'role_view_scopes may only transition once from active to revoked';
  END IF;
  IF NEW.revoked_by_user_id IS NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'role_view_scopes revocation requires actor and timestamp';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_view_scopes_no_rewrite
BEFORE UPDATE ON role_view_scopes
FOR EACH ROW EXECUTE FUNCTION prevent_role_view_scope_mutation();

CREATE OR REPLACE FUNCTION prevent_role_view_scope_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'role_view_scopes are revoked, not deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_view_scopes_no_delete
BEFORE DELETE ON role_view_scopes
FOR EACH ROW EXECUTE FUNCTION prevent_role_view_scope_delete();

CREATE TABLE role_view_scope_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id uuid NOT NULL REFERENCES role_view_scopes(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_type role_view_scope_audit_event NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scope_id, tenant_id) REFERENCES role_view_scopes(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX role_view_scope_audit_scope_idx ON role_view_scope_audit(scope_id, created_at);
CREATE INDEX role_view_scope_audit_tenant_idx ON role_view_scope_audit(tenant_id, created_at);

CREATE OR REPLACE FUNCTION prevent_role_view_scope_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'role_view_scope_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_view_scope_audit_no_update
BEFORE UPDATE ON role_view_scope_audit
FOR EACH ROW EXECUTE FUNCTION prevent_role_view_scope_audit_mutation();
CREATE TRIGGER role_view_scope_audit_no_delete
BEFORE DELETE ON role_view_scope_audit
FOR EACH ROW EXECUTE FUNCTION prevent_role_view_scope_audit_mutation();

-- The trigger writes the ledger under the migration owner. Runtime code cannot
-- forge audit rows because it receives SELECT-only access to this table.
CREATE OR REPLACE FUNCTION audit_role_view_scope_change() RETURNS trigger
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO role_view_scope_audit(scope_id, tenant_id, event_type, actor_user_id)
    VALUES (NEW.id, NEW.tenant_id, 'granted', NEW.granted_by_user_id);
  ELSIF OLD.active = true AND NEW.active = false THEN
    INSERT INTO role_view_scope_audit(scope_id, tenant_id, event_type, actor_user_id)
    VALUES (NEW.id, NEW.tenant_id, 'revoked', NEW.revoked_by_user_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_view_scopes_audit_change
AFTER INSERT OR UPDATE OF active ON role_view_scopes
FOR EACH ROW EXECUTE FUNCTION audit_role_view_scope_change();

-- This view contains only permitted stage identities, never tags or subject
-- data. Step 2 will use it as the server-side additive scope source.
CREATE VIEW role_view_scope_allowed_stages AS
SELECT scope.tenant_role_id, scope.tenant_id, scope.stage_id
FROM role_view_scopes scope
JOIN tenant_roles role ON role.id = scope.tenant_role_id AND role.tenant_id = scope.tenant_id
JOIN stages stage ON stage.id = scope.stage_id AND stage.tenant_id = scope.tenant_id
WHERE scope.active = true AND role.active = true AND stage.active = true
  AND scope.scope_kind = 'own_stage'
UNION
SELECT scope.tenant_role_id, scope.tenant_id, stage.id AS stage_id
FROM role_view_scopes scope
JOIN tenant_roles role ON role.id = scope.tenant_role_id AND role.tenant_id = scope.tenant_id
JOIN stages stage ON stage.unit_id = scope.unit_id AND stage.tenant_id = scope.tenant_id
WHERE scope.active = true AND role.active = true AND stage.active = true
  AND scope.scope_kind = 'unit'
UNION
SELECT scope.tenant_role_id, scope.tenant_id, stage.id AS stage_id
FROM role_view_scopes scope
JOIN tenant_roles role ON role.id = scope.tenant_role_id AND role.tenant_id = scope.tenant_id
JOIN stages stage ON stage.tenant_id = scope.tenant_id
WHERE scope.active = true AND role.active = true AND stage.active = true
  AND scope.scope_kind = 'tenant';

GRANT SELECT, INSERT, UPDATE ON units, role_view_scopes TO safetyspell_app;
REVOKE DELETE, TRUNCATE ON units, role_view_scopes FROM safetyspell_app;
GRANT SELECT ON role_view_scope_audit, role_view_scope_allowed_stages TO safetyspell_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON role_view_scope_audit FROM safetyspell_app;
