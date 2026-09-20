import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createPublicTagCode } from "../src/domain/tag-code";

describe("Step 2 tenant boundary and category-integrity schema", () => {
  const adminDbUrl =
    process.env.INTEGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/safetyspell_integration";
  const appDbUrl = adminDbUrl.replace(
    /postgres:\/\/[^@]+@/,
    "postgres://safetyspell_app:safetyspell_app_password@",
  );

  let adminPool: Pool;
  let appPool: Pool;
  let medicalCategoryId: string;
  let elderlyCategoryId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminDbUrl });
    appPool = new Pool({ connectionString: appDbUrl });
    medicalCategoryId = (await adminPool.query("SELECT id FROM categories WHERE key = 'medical'"))
      .rows[0].id;
    elderlyCategoryId = (await adminPool.query("SELECT id FROM categories WHERE key = 'elderly'"))
      .rows[0].id;
  });

  afterAll(async () => {
    await appPool.end();
    await adminPool.end();
  });

  async function createTenant(name: string): Promise<string> {
    const result = await adminPool.query<{ id: string }>(
      "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
      [name],
    );
    return result.rows[0]!.id;
  }

  async function createUser(tenantId: string): Promise<string> {
    const id = randomUUID();
    await adminPool.query(
      `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
       VALUES($1, 'Tenant guardian', $2, 'hash', 'guardian', $3)`,
      [id, `${id}@example.test`, tenantId],
    );
    return id;
  }

  async function createWard(tenantId: string, category = "medical"): Promise<string> {
    const id = randomUUID();
    const categoryId = category === "medical" ? medicalCategoryId : elderlyCategoryId;
    await adminPool.query(
      `INSERT INTO wards(id, category, category_id, name, tenant_id)
       VALUES($1, $2, $3, 'Tenant ward', $4)`,
      [id, category, categoryId, tenantId],
    );
    return id;
  }

  async function createTag(tenantId: string, category = "medical"): Promise<string> {
    const id = randomUUID();
    const categoryId = category === "medical" ? medicalCategoryId : elderlyCategoryId;
    await adminPool.query(
      `INSERT INTO tags(id, code, category, category_id, form, inventory_status, holder_kind, tenant_id)
       VALUES($1, $2, $3, $4, 'card', 'blank', 'company', $5)`,
      [id, createPublicTagCode(), category, categoryId, tenantId],
    );
    return id;
  }

  it("has exactly the two explicit category kinds and normalized category foreign keys", async () => {
    const kinds = await adminPool.query("SELECT DISTINCT kind FROM categories ORDER BY kind");
    expect(kinds.rows.map((row) => row.kind)).toEqual(["consent_governed_person", "plain_asset"]);

    const constraints = await adminPool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('wards_category_pair_fk', 'field_catalog_category_pair_fk', 'tags_category_pair_fk')
       ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "field_catalog_category_pair_fk",
      "tags_category_pair_fk",
      "wards_category_pair_fk",
    ]);
  });

  it("rejects a ward guardian relation across tenants", async () => {
    const tenantA = await createTenant(`Guardian A ${randomUUID()}`);
    const tenantB = await createTenant(`Guardian B ${randomUUID()}`);
    const userA = await createUser(tenantA);
    const wardB = await createWard(tenantB);

    await expect(
      adminPool.query(
        `INSERT INTO ward_guardians(ward_id, user_id, tenant_id, relationship, authority_basis)
         VALUES($1, $2, $3, 'parent', 'test')`,
        [wardB, userA, tenantA],
      ),
    ).rejects.toThrow(/ward_guardians_ward_tenant_fk/);
  });

  it("rejects a tag-to-ward association across tenants", async () => {
    const tenantA = await createTenant(`Tag A ${randomUUID()}`);
    const tenantB = await createTenant(`Ward B ${randomUUID()}`);
    const tagA = await createTag(tenantA);
    const wardB = await createWard(tenantB);

    await expect(
      adminPool.query("UPDATE tags SET ward_id = $2 WHERE id = $1", [tagA, wardB]),
    ).rejects.toThrow(/tags_ward_tenant_fk/);
  });

  it("rejects a tag assigned to a batch from another tenant", async () => {
    const tenantA = await createTenant(`Batch A ${randomUUID()}`);
    const tenantB = await createTenant(`Tag B ${randomUUID()}`);
    const userA = await createUser(tenantA);
    const batch = await adminPool.query<{ id: string }>(
      `INSERT INTO tag_batches(batch_code, category_id, form, quantity, created_by_user_id, tenant_id)
       VALUES($1, $2, 'card', 1, $3, $4) RETURNING id`,
      [`B-${randomUUID()}`, medicalCategoryId, userA, tenantA],
    );
    const tagB = await createTag(tenantB);

    await expect(
      adminPool.query("UPDATE tags SET batch_id = $2 WHERE id = $1", [tagB, batch.rows[0]!.id]),
    ).rejects.toThrow(/tags_batch_category_tenant_fk/);
  });

  it("rejects a tag and ward category mismatch at the database boundary", async () => {
    const tenant = await createTenant(`Category ${randomUUID()}`);
    const tag = await createTag(tenant, "elderly");
    const ward = await createWard(tenant, "medical");

    await expect(
      adminPool.query("UPDATE tags SET ward_id = $2 WHERE id = $1", [tag, ward]),
    ).rejects.toThrow(/tags_ward_category_fk/);
  });

  it("refuses app-role tenant reassignment on tags and wards", async () => {
    const tenantA = await createTenant(`Immutable A ${randomUUID()}`);
    const tenantB = await createTenant(`Immutable B ${randomUUID()}`);
    const tag = await createTag(tenantA);
    const ward = await createWard(tenantA);

    await expect(
      appPool.query("UPDATE tags SET tenant_id = $2 WHERE id = $1", [tag, tenantB]),
    ).rejects.toThrow(/tags tenant_id is immutable/);
    await expect(
      appPool.query("UPDATE wards SET tenant_id = $2 WHERE id = $1", [ward, tenantB]),
    ).rejects.toThrow(/wards tenant_id is immutable/);
  });

  it("keeps legacy status as an app-role read-only canonical mirror", async () => {
    const tenant = await createTenant(`Lifecycle ${randomUUID()}`);
    const tag = await createTag(tenant);

    await expect(
      appPool.query("UPDATE tags SET status = 'active' WHERE id = $1", [tag]),
    ).rejects.toThrow(/read-only mirror/);
    await appPool.query("UPDATE tags SET inventory_status = 'lost' WHERE id = $1", [tag]);
    await expect(
      adminPool.query("SELECT inventory_status, status FROM tags WHERE id = $1", [tag]),
    ).resolves.toMatchObject({ rows: [{ inventory_status: "lost", status: "lost" }] });
  });

  it("derives ledger tenant through immutable parents and excludes null-parent scan logs", async () => {
    const tenant = await createTenant(`Audit ${randomUUID()}`);
    const user = await createUser(tenant);
    const ward = await createWard(tenant);
    const tag = await createTag(tenant);

    await adminPool.query(
      `INSERT INTO tag_events(tag_id, event_type, actor_user_id, from_status, to_status)
       VALUES($1, 'created', $2, 'blank', 'blank')`,
      [tag, user],
    );
    await adminPool.query(
      "INSERT INTO scan_log(tag_id, policy_version, shown_field_keys) VALUES($1, 1, '[]'::jsonb)",
      [tag],
    );
    await adminPool.query(
      "INSERT INTO scan_log(tag_id, policy_version, shown_field_keys) VALUES(NULL, 1, '[]'::jsonb)",
    );
    await adminPool.query(
      `INSERT INTO consent_audit(ward_id, event_type, changed_by)
       VALUES($1, 'public_release_withdrawn', $2)`,
      [ward, user],
    );

    const rows = await adminPool.query<{ ledger_type: string; tenant_id: string }>(
      "SELECT ledger_type, tenant_id FROM tenant_ledger_audit WHERE tenant_id = $1 ORDER BY ledger_type",
      [tenant],
    );
    expect(rows.rows).toEqual([
      { ledger_type: "consent_audit", tenant_id: tenant },
      { ledger_type: "scan_log", tenant_id: tenant },
      { ledger_type: "tag_event", tenant_id: tenant },
    ]);
    const unknownScanInView = await adminPool.query(
      "SELECT 1 FROM tenant_ledger_audit WHERE ledger_type = 'scan_log' AND parent_id IS NULL",
    );
    expect(unknownScanInView.rows).toHaveLength(0);
  });

  it("keeps append-only ledgers tenant-column-free and Step 1 triggers intact", async () => {
    const columns = await adminPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('tag_events', 'scan_log', 'consent_audit')
         AND column_name = 'tenant_id'`,
    );
    expect(columns.rows).toEqual([]);

    const triggers = await adminPool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN (
         'tag_events_no_update', 'tag_events_no_delete',
         'consent_audit_no_update', 'consent_audit_no_delete',
         'scan_log_no_update', 'scan_log_no_delete'
       ) ORDER BY tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "consent_audit_no_delete",
      "consent_audit_no_update",
      "scan_log_no_delete",
      "scan_log_no_update",
      "tag_events_no_delete",
      "tag_events_no_update",
    ]);

    const privileges = await adminPool.query<{
      table_name: string;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>(
      `SELECT table_name,
              has_table_privilege('safetyspell_app', format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege('safetyspell_app', format('public.%I', table_name), 'DELETE') AS can_delete,
              has_table_privilege('safetyspell_app', format('public.%I', table_name), 'TRUNCATE') AS can_truncate
       FROM unnest(ARRAY['tag_events', 'scan_log', 'consent_audit']) AS table_name
       ORDER BY table_name`,
    );
    expect(privileges.rows).toEqual([
      { table_name: "consent_audit", can_update: false, can_delete: false, can_truncate: false },
      { table_name: "scan_log", can_update: false, can_delete: false, can_truncate: false },
      { table_name: "tag_events", can_update: false, can_delete: false, can_truncate: false },
    ]);
  });

  it("stops an ambiguous two-tenant pre-Step-2 backfill before it can guess ownership", async () => {
    const databaseName = `safetyspell_step2_ambiguity_${randomUUID().replaceAll("-", "")}`;
    const targetUrl = new URL(adminDbUrl);
    targetUrl.pathname = `/${databaseName}`;
    const migrationDirectory = join(__dirname, "../src/database/migrations");
    const preStep2Migrations = (await readdir(migrationDirectory))
      .filter(
        (name) =>
          /^\d+_.*\.sql$/.test(name) && name < "021_tenant_boundary_and_category_integrity.sql",
      )
      .sort();

    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    const rehearsalPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
    try {
      for (const migrationName of preStep2Migrations) {
        await rehearsalPool.query(await readFile(join(migrationDirectory, migrationName), "utf8"));
      }
      await rehearsalPool.query(
        `INSERT INTO tenants(name, type) VALUES
           ('Ambiguity rehearsal A', 'hospital'),
           ('Ambiguity rehearsal B', 'hospital')`,
      );

      await expect(
        rehearsalPool.query(
          await readFile(
            join(migrationDirectory, "021_tenant_boundary_and_category_integrity.sql"),
            "utf8",
          ),
        ),
      ).rejects.toThrow(/tenant backfill is ambiguous/);
    } finally {
      await rehearsalPool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    }
  }, 60_000);

  it("stops the lifecycle cutover when a legacy and canonical tag state diverge", async () => {
    const databaseName = `safetyspell_step4_divergence_${randomUUID().replaceAll("-", "")}`;
    const targetUrl = new URL(adminDbUrl);
    targetUrl.pathname = `/${databaseName}`;
    const migrationDirectory = join(__dirname, "../src/database/migrations");
    const preStep4Migrations = (await readdir(migrationDirectory))
      .filter((name) => /^\d+_.*\.sql$/.test(name) && name < "022_canonical_tag_lifecycle.sql")
      .sort();

    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    const rehearsalPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
    const legacyActiveTagId = randomUUID();
    const canonicalActiveTagId = randomUUID();
    try {
      for (const migrationName of preStep4Migrations) {
        await rehearsalPool.query(await readFile(join(migrationDirectory, migrationName), "utf8"));
      }
      await rehearsalPool.query(
        `INSERT INTO tags(id, code, category, category_id, form, status, inventory_status, holder_kind)
         VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'blank', 'company')`,
        [legacyActiveTagId, createPublicTagCode()],
      );
      await rehearsalPool.query(
        `INSERT INTO tags(id, code, category, category_id, form, status, inventory_status, holder_kind)
         VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'active', 'company')`,
        [canonicalActiveTagId, createPublicTagCode()],
      );

      const sortedIds = [legacyActiveTagId, canonicalActiveTagId].sort();
      await expect(
        rehearsalPool.query(
          await readFile(join(migrationDirectory, "022_canonical_tag_lifecycle.sql"), "utf8"),
        ),
      ).rejects.toThrow(
        new RegExp(`tag lifecycle parity failed.*${sortedIds[0]}.*${sortedIds[1]}`, "s"),
      );
    } finally {
      await rehearsalPool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    }
  }, 60_000);
});
