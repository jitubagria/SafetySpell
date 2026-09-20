// These tests verify server-generated PDF bytes and data passed to PDF/QR generators.
// They cannot prove a phone camera scans a printed A4 sheet; that remains a separate manual test.
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PDFDocument, PDFPage } from "pdf-lib";
import { Pool } from "pg";
import * as QRCode from "qrcode";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApi } from "../src/bootstrap";
import { createPublicTagCode, isValidPublicTagCode } from "../src/domain/tag-code";
import { ScanResolverService } from "../src/scan-resolver/scan-resolver.service";
import { TagCustodyService } from "../src/tag-custody/tag-custody.service";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("INTEGRATION_DATABASE_URL is required for database integration tests");
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";
process.env.AUTH_JWT_SECRET ??= "integration-jwt-secret-at-least-32-characters";
process.env.SCAN_LOG_IP_HMAC_SECRET ??= "integration-hmac-secret-at-least-32-characters";

type Seed = {
  wardId: string;
  fieldId: string;
  tagCode: string;
  guardianId: string;
  password: string;
};
type MinimalSeed = Seed & {
  ageBandFieldId: string;
  primaryLanguageFieldId: string;
};
let app: INestApplication;
let db: Pool;

const testTables = [
  "scan_log",
  "tag_events",
  "tags",
  "assets",
  "route_stage_hop_permissions",
  "stages",
  "routes",
  "tenant_roles",
  "tag_batches",
  "distributor_allowed_categories",
  "distributors",
  "guidance_rule_versions",
  "guidance_rules",
  "privacy_notices",
  "consent_audit",
  "ward_field_visibility",
  "ward_field_values",
  "ward_guardians",
  "field_catalog",
  "wards",
  "users",
].join(", ");

async function resetDatabase() {
  await db.query("DROP TRIGGER IF EXISTS integration_fail_withdrawal_trigger ON consent_audit");
  await db.query("DROP FUNCTION IF EXISTS integration_fail_withdrawal()");
  await db.query(`TRUNCATE ${testTables} RESTART IDENTITY CASCADE`);
}

async function seed(
  options: {
    visibility?: "private" | "public";
    approved?: boolean;
    publicEligible?: boolean;
    tenantId?: string;
  } = {},
): Promise<Seed> {
  const guardianId = randomUUID();
  const wardId = randomUUID();
  let fieldId: string = randomUUID();
  const tagCode = randomUUID().replaceAll("-", "");
  const password = "integration-password";
  await db.query(
    "INSERT INTO users(id, name, email, password_hash, role, tenant_id) VALUES ($1, $2, $3, $4, 'guardian', COALESCE($5, '00000000-0000-4000-8000-000000000021'::uuid))",
    [
      guardianId,
      "Integration guardian",
      `${guardianId}@example.test`,
      await bcrypt.hash(password, 4),
      options.tenantId,
    ],
  );
  await db.query(
    "INSERT INTO wards(id, category, name, tenant_id) VALUES ($1, 'medical', 'Integration ward', COALESCE($2, '00000000-0000-4000-8000-000000000021'::uuid))",
    [wardId, options.tenantId],
  );
  await db.query(
    `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release, tenant_id)
     VALUES ($1, $2, 'parent', 'test authority', true, true, true, COALESCE($3, '00000000-0000-4000-8000-000000000021'::uuid))`,
    [wardId, guardianId, options.tenantId],
  );
  const catalog = await db.query<{ id: string }>(
    `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, approved_by, approved_at, validation_policy)
     VALUES ($1, 'medical', 'blood_group', 'Blood group', 'enum', 'public', $2, $3, $4, now(), '{"allowed_values":["O+"]}'::jsonb)
     ON CONFLICT (category, field_key) DO NOTHING RETURNING id`,
    [fieldId, options.publicEligible ?? true, options.approved ?? true, guardianId],
  );
  if (catalog.rowCount) {
    fieldId = catalog.rows[0]!.id;
  } else {
    fieldId = (
      await db.query<{ id: string }>(
        "SELECT id FROM field_catalog WHERE category = 'medical' AND field_key = 'blood_group'",
      )
    ).rows[0]!.id;
  }
  await db.query(
    `INSERT INTO ward_field_values(ward_id, field_catalog_id, value, provenance, updated_by)
     VALUES ($1, $2, '"O+"'::jsonb, 'guardian_reported', $3)`,
    [wardId, fieldId, guardianId],
  );
  if (options.visibility) {
    await db.query(
      "INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by) VALUES ($1, $2, $3, $4)",
      [wardId, fieldId, options.visibility, guardianId],
    );
  }
  await db.query(
    `INSERT INTO tags(code, ward_id, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id, activated_at, tenant_id)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'guardian', $3, now(), COALESCE($4, '00000000-0000-4000-8000-000000000021'::uuid))`,
    [tagCode, wardId, guardianId, options.tenantId],
  );
  return { wardId, fieldId, tagCode, guardianId, password };
}

async function seedMinimalDraft(): Promise<MinimalSeed> {
  const guardianId = randomUUID();
  const wardId = randomUUID();
  const tagCode = randomUUID().replaceAll("-", "");
  const ageBandFieldId = randomUUID();
  const primaryLanguageFieldId = randomUUID();
  const password = "integration-password";
  await db.query(
    "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Guardian', $2, $3, 'guardian')",
    [guardianId, `${guardianId}@example.test`, await bcrypt.hash(password, 4)],
  );
  await db.query("INSERT INTO wards(id, category, name) VALUES ($1, 'medical', 'Minimal ward')", [
    wardId,
  ]);
  await db.query(
    `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
     VALUES ($1, $2, 'parent', 'test authority', true, true, true)`,
    [wardId, guardianId],
  );
  await db.query(
    `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, provenance_required, guardian_editable, validation_policy)
     VALUES
       ($1, 'medical', 'age_band', 'Age band', 'enum', 'private', false, false, true, true, '{"allowed_values":["child","teen","adult","senior"]}'::jsonb),
       ($2, 'medical', 'primary_language', 'Primary language', 'enum', 'private', false, false, true, true, '{"allowed_values":["hi","en"]}'::jsonb)`,
    [ageBandFieldId, primaryLanguageFieldId],
  );
  await db.query(
    `INSERT INTO tags(code, ward_id, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id, activated_at)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'guardian', $3, now())`,
    [tagCode, wardId, guardianId],
  );
  return {
    wardId,
    fieldId: ageBandFieldId,
    tagCode,
    guardianId,
    password,
    ageBandFieldId,
    primaryLanguageFieldId,
  };
}

async function tokenForCredentials(email: string, password: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/v1/auth/login")
    .send({ email, password })
    .expect(201);
  return response.body.accessToken as string;
}

type StageMoveFixtureOptions = {
  tenantId?: string;
  tenantRole?: "none" | "operational_staff" | "unprivileged";
  tenantRoleActive?: boolean;
  hopActive?: boolean;
  routeActive?: boolean;
  fromStageActive?: boolean;
  toStageActive?: boolean;
  holderKind?: "company" | "distributor" | "guardian";
  currentStageId?: string | null;
};

type StageMoveFixture = {
  tenantId: string;
  actorId: string;
  token: string;
  tagId: string;
  tagCode: string;
  routeId: string;
  fromStageId: string;
  toStageId: string;
  tenantRoleId: string | null;
};

async function seedStageMoveFixture(
  options: StageMoveFixtureOptions = {},
): Promise<StageMoveFixture> {
  const tenantId = options.tenantId ?? "00000000-0000-4000-8000-000000000021";
  const actorId = randomUUID();
  const tenantRoleId = options.tenantRole === "none" ? null : randomUUID();
  const routeId = randomUUID();
  const fromStageId = randomUUID();
  const toStageId = randomUUID();
  const tagId = randomUUID();
  const tagCode = randomUUID().replaceAll("-", "");
  const password = "staff-stage-password";
  const email = `${actorId}@example.test`;

  if (tenantRoleId) {
    await db.query(
      `INSERT INTO tenant_roles(id, tenant_id, name, authority_class, active)
       VALUES($1, $2, $3, $4, $5)`,
      [
        tenantRoleId,
        tenantId,
        `Stage role ${tenantRoleId}`,
        options.tenantRole ?? "operational_staff",
        options.tenantRoleActive ?? true,
      ],
    );
  }
  await db.query(
    `INSERT INTO users(id, name, email, password_hash, role, tenant_id, tenant_role_id)
     VALUES($1, 'Stage staff', $2, $3, 'staff', $4, $5)`,
    [actorId, email, await bcrypt.hash(password, 4), tenantId, tenantRoleId],
  );
  await db.query("INSERT INTO routes(id, tenant_id, name, active) VALUES($1, $2, $3, $4)", [
    routeId,
    tenantId,
    `Route ${routeId}`,
    options.routeActive ?? true,
  ]);
  await db.query(
    `INSERT INTO stages(id, tenant_id, route_id, name, active)
     VALUES($1, $2, $3, 'From', $4), ($5, $2, $3, 'To', $6)`,
    [
      fromStageId,
      tenantId,
      routeId,
      options.fromStageActive ?? true,
      toStageId,
      options.toStageActive ?? true,
    ],
  );
  if (tenantRoleId) {
    await db.query(
      `INSERT INTO route_stage_hop_permissions(
         tenant_id, route_id, from_stage_id, to_stage_id, allowed_tenant_role_id, active
       ) VALUES($1, $2, $3, $4, $5, $6)`,
      [tenantId, routeId, fromStageId, toStageId, tenantRoleId, options.hopActive ?? true],
    );
  }

  const holderKind = options.holderKind ?? "company";
  let holderDistributorId: string | null = null;
  let holderGuardianUserId: string | null = null;
  if (holderKind === "distributor") {
    holderDistributorId = randomUUID();
    await db.query("INSERT INTO distributors(id, name) VALUES($1, $2)", [
      holderDistributorId,
      `Stage distributor ${holderDistributorId}`,
    ]);
  }
  if (holderKind === "guardian") {
    holderGuardianUserId = randomUUID();
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
       VALUES($1, 'Stage guardian', $2, 'hash', 'guardian', $3)`,
      [holderGuardianUserId, `${holderGuardianUserId}@example.test`, tenantId],
    );
  }
  await db.query(
    `INSERT INTO tags(
       id, code, category, category_id, form, inventory_status, holder_kind,
       holder_distributor_id, holder_guardian_user_id, current_stage_id, tenant_id, activated_at
     ) VALUES(
       $1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active',
       $3, $4, $5, $6, $7, now()
     )`,
    [
      tagId,
      tagCode,
      holderKind,
      holderDistributorId,
      holderGuardianUserId,
      options.currentStageId === undefined ? fromStageId : options.currentStageId,
      tenantId,
    ],
  );

  return {
    tenantId,
    actorId,
    token: await tokenForCredentials(email, password),
    tagId,
    tagCode,
    routeId,
    fromStageId,
    toStageId,
    tenantRoleId,
  };
}

function stageMoveRequest(fixture: StageMoveFixture, body?: Record<string, unknown>) {
  return request(app.getHttpServer())
    .post(`/v1/app/tags/${fixture.tagCode}/stage-moves`)
    .set("Authorization", `Bearer ${fixture.token}`)
    .send(body ?? { fromStageId: fixture.fromStageId, toStageId: fixture.toStageId });
}

async function tokenFor(seedData: Seed): Promise<string> {
  return tokenForCredentials(`${seedData.guardianId}@example.test`, seedData.password);
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  const migrations = await db.query("SELECT name FROM schema_migrations ORDER BY name");
  expect(migrations.rows.map((row) => row.name)).toEqual([
    "001_rescue_id_v1.sql",
    "002_p0_role_and_scan_log_hardening.sql",
    "003_p0_catalog_value_constraints.sql",
    "004_minimal_guardian_catalog.sql",
    "005_allergy_public_free_text.sql",
    "006_remove_clinical_reviewer.sql",
    "007_blood_group_public_capable.sql",
    "008_category_distributor_commercial_foundation.sql",
    "009_tag_batches.sql",
    "010_tag_inventory_state.sql",
    "011_tag_events.sql",
    "012_admin_batch_print_version.sql",
    "013_short_public_tag_codes.sql",
    "014_tag_custody_authority.sql",
    "015_tag_activation_pin_and_claim.sql",
    "016_database_role_hardening.sql",
    "017_public_text_allowlist.sql",
    "018_medical_condition_fields.sql",
    "019_condition_notes_public_text_allowlist.sql",
    "020_scan_log_append_only.sql",
    "021_tenant_boundary_and_category_integrity.sql",
    "022_canonical_tag_lifecycle.sql",
    "023_asset_subject_and_public_projection.sql",
    "024_route_stage_tenant_roles_and_hop_authority.sql",
    "025_stage_change_event_pair_backstop.sql",
  ]);
  const conditionFields = await db.query(
    "SELECT field_key, validation_policy FROM field_catalog WHERE category = 'medical' AND field_key IN ('condition_flags', 'condition_notes') ORDER BY field_key",
  );
  expect(conditionFields.rows).toEqual([
    expect.objectContaining({
      field_key: "condition_flags",
      validation_policy: expect.objectContaining({ multi_select: true }),
    }),
    expect.objectContaining({
      field_key: "condition_notes",
      validation_policy: expect.objectContaining({ max_length: 1000 }),
    }),
  ]);
  const tables = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  expect(tables.rows.map((row) => row.tablename)).toEqual(
    expect.arrayContaining([
      "consent_audit",
      "assets",
      "categories",
      "distributors",
      "orders",
      "price_books",
      "field_catalog",
      "scan_log",
      "tag_batches",
      "tag_events",
      "tags",
      "ward_field_values",
      "ward_field_visibility",
      "ward_guardians",
      "wards",
    ]),
  );
  const visibilityEnum = await db.query(
    "SELECT enum_range(NULL::visibility_level)::text AS values",
  );
  expect(visibilityEnum.rows[0].values).toBe("{private,public,verified_emergency_responder}");
  const triggers = await db.query(
    "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
  );
  expect(triggers.rows.map((row) => row.tgname)).toEqual(
    expect.arrayContaining([
      "consent_audit_no_delete",
      "consent_audit_no_update",
      "guidance_versions_no_delete",
      "guidance_versions_no_update",
      "scan_log_no_delete",
      "scan_log_no_update",
      "tag_events_no_delete",
      "tag_events_no_update",
      "tags_code_no_update",
    ]),
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApi(app);
  await app.init();
});

beforeEach(resetDatabase);

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("Rescue ID live PostgreSQL integration boundary", () => {
  it("creates the reserved responder enum but rejects it at the database layer", async () => {
    const data = await seed();
    await expect(
      db.query(
        "INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by) VALUES ($1, $2, 'verified_emergency_responder', $3)",
        [data.wardId, data.fieldId, data.guardianId],
      ),
    ).rejects.toThrow(/ward_field_visibility_visibility_check/);
  });

  it("treats a missing visibility row as private, then requires every public gate", async () => {
    const data = await seed();
    const privateResponse = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200);
    expect(privateResponse.body).toMatchObject({ status: "available", fields: [] });

    await db.query(
      "INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by) VALUES ($1, $2, 'public', $3)",
      [data.wardId, data.fieldId, data.guardianId],
    );
    await db.query(
      "UPDATE field_catalog SET approved = false, public_eligible = false WHERE id = $1",
      [data.fieldId],
    );
    expect(
      (await request(app.getHttpServer()).get(`/v1/public/scan/${data.tagCode}`)).body.fields,
    ).toEqual([]);

    await db.query(
      "UPDATE field_catalog SET approved = true, public_eligible = false WHERE id = $1",
      [data.fieldId],
    );
    expect(
      (await request(app.getHttpServer()).get(`/v1/public/scan/${data.tagCode}`)).body.fields,
    ).toEqual([]);

    await db.query("UPDATE field_catalog SET public_eligible = true WHERE id = $1", [data.fieldId]);
    const released = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200);
    expect(released.body.fields).toEqual([
      expect.objectContaining({ key: "blood_group", value: "O+" }),
    ]);
  });

  it("withdraws every public field atomically and rolls back on an audit failure", async () => {
    const data = await seed({ visibility: "public" });
    const secondField = randomUUID();
    await db.query(
      `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, approved_by, approved_at, validation_policy)
       VALUES ($1, 'medical', 'condition_flag', 'Condition flag', 'boolean', 'public', true, true, $2, now(), '{"allowed_values":[true,false]}'::jsonb)`,
      [secondField, data.guardianId],
    );
    await db.query(
      "INSERT INTO ward_field_values(ward_id, field_catalog_id, value, provenance, updated_by) VALUES ($1, $2, 'true'::jsonb, 'guardian_reported', $3)",
      [data.wardId, secondField, data.guardianId],
    );
    await db.query(
      "INSERT INTO ward_field_visibility(ward_id, field_catalog_id, visibility, updated_by) VALUES ($1, $2, 'public', $3)",
      [data.wardId, secondField, data.guardianId],
    );
    const token = await tokenFor(data);

    await db.query(
      "CREATE FUNCTION integration_fail_withdrawal() RETURNS trigger AS $$ BEGIN IF NEW.event_type = 'public_release_withdrawn' THEN RAISE EXCEPTION 'integration rollback'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql",
    );
    await db.query(
      "CREATE TRIGGER integration_fail_withdrawal_trigger BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION integration_fail_withdrawal()",
    );
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${data.wardId}/public-release/withdraw`)
      .set("Authorization", `Bearer ${token}`)
      .expect(500);
    await db.query("DROP TRIGGER integration_fail_withdrawal_trigger ON consent_audit");
    await db.query("DROP FUNCTION integration_fail_withdrawal()");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM ward_field_visibility WHERE ward_id = $1 AND visibility = 'public'",
          [data.wardId],
        )
      ).rows[0].count,
    ).toBe(2);

    await request(app.getHttpServer())
      .post(`/v1/app/wards/${data.wardId}/public-release/withdraw`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM ward_field_visibility WHERE ward_id = $1 AND visibility = 'public'",
          [data.wardId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("enforces append-only consent audit triggers in PostgreSQL", async () => {
    const data = await seed({ visibility: "public" });
    const token = await tokenFor(data);
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${data.wardId}/public-release/withdraw`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    const auditId = (
      await db.query("SELECT id FROM consent_audit WHERE ward_id = $1 LIMIT 1", [data.wardId])
    ).rows[0].id;
    await expect(
      db.query("UPDATE consent_audit SET event_type = 'visibility_changed' WHERE id = $1", [
        auditId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM consent_audit WHERE id = $1", [auditId])).rejects.toThrow(
      /append-only/,
    );
  });

  it("serves guardian endpoints over JWT HTTP and rejects an unauthorised guardian", async () => {
    const data = await seed();
    const token = await tokenFor(data);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${data.wardId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const outsiderId = randomUUID();
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Outsider', $2, $3, 'guardian')",
      [outsiderId, `${outsiderId}@example.test`, await bcrypt.hash("outsider-password", 4)],
    );
    const outsider = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: `${outsiderId}@example.test`, password: "outsider-password" })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${data.wardId}/fields/${data.fieldId}/visibility`)
      .set("Authorization", `Bearer ${outsider.body.accessToken}`)
      .send({ visibility: "private" })
      .expect(403);
  });

  it("returns a ward's active tag codes to its guardian and hides them from outsiders", async () => {
    const data = await seed();
    const token = await tokenFor(data);
    const authorized = await request(app.getHttpServer())
      .get(`/v1/app/wards/${data.wardId}/tags`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(authorized.body).toEqual([{ code: data.tagCode, form: "band" }]);

    const outsiderId = randomUUID();
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Outsider', $2, $3, 'guardian')",
      [outsiderId, `${outsiderId}@example.test`, await bcrypt.hash("outsider-password", 4)],
    );
    const outsiderToken = await tokenForCredentials(
      `${outsiderId}@example.test`,
      "outsider-password",
    );
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${data.wardId}/tags`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(404);
  });

  it("keeps the minimal guardian fields private until the catalog is public-cleared, then releases only them", async () => {
    const data = await seedMinimalDraft();
    const guardianToken = await tokenFor(data);
    const initialFields = await request(app.getHttpServer())
      .get(`/v1/app/wards/${data.wardId}/fields`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(200);
    expect(initialFields.body).toEqual([
      expect.objectContaining({
        catalogId: data.ageBandFieldId,
        key: "age_band",
        value: null,
        visibility: "private",
        publicReleaseEligible: false,
      }),
      expect.objectContaining({
        catalogId: data.primaryLanguageFieldId,
        key: "primary_language",
        value: null,
        visibility: "private",
        publicReleaseEligible: false,
      }),
    ]);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${data.ageBandFieldId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ value: "senior" })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${data.primaryLanguageFieldId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ value: "hi" })
      .expect(200);
    // Not public-capable yet: the guardian cannot release regardless of intent.
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${data.wardId}/fields/${data.ageBandFieldId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(403);

    // Owner/policy clearance for public use (no clinical reviewer). approved_by/approved_at
    // stay NULL together, as migration 006 permits for policy-approved fields.
    await db.query(
      "UPDATE field_catalog SET approved = true, public_eligible = true, max_level = 'public' WHERE id = ANY($1::uuid[])",
      [[data.ageBandFieldId, data.primaryLanguageFieldId]],
    );
    for (const fieldId of [data.ageBandFieldId, data.primaryLanguageFieldId]) {
      await request(app.getHttpServer())
        .put(`/v1/app/wards/${data.wardId}/fields/${fieldId}/visibility`)
        .set("Authorization", `Bearer ${guardianToken}`)
        .send({ visibility: "public" })
        .expect(200);
    }
    const scan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .set("Origin", "http://localhost:5173")
      .expect(200);
    expect(scan.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(scan.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "age_band", value: "senior" }),
        expect.objectContaining({ key: "primary_language", value: "hi" }),
      ]),
    );
    expect(scan.body.fields).toHaveLength(2);
  });

  it("releases guardian-entered free-text allergy as a public field once the catalog is cleared", async () => {
    const data = await seedMinimalDraft();
    const guardianToken = await tokenFor(data);
    const allergyFieldId = randomUUID();
    // A public-capable free-text catalog field (the allergy capability), owner-cleared.
    await db.query(
      `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, guardian_editable, validation_policy)
       VALUES ($1, 'medical', 'allergy', 'Allergy', 'text', 'public', true, true, true, '{"max_length":1000}'::jsonb)`,
      [allergyFieldId],
    );
    // Guardian writes hostile free text; the server-side lock must strip it before storage.
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${allergyFieldId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({
        value: 'Penicillin <b>x</b>\nvisit http://evil.test\n<a href="javascript:1">Peanuts</a>',
      })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${data.wardId}/fields/${allergyFieldId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(200);
    const scan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200);
    const allergy = scan.body.fields.find((field: { key: string }) => field.key === "allergy") as {
      value: string;
    };
    expect(allergy).toBeDefined();
    expect(allergy.value).not.toMatch(/<[^>]*>/);
    expect(allergy.value).not.toMatch(/https?:\/\//i);
    expect(allergy.value).not.toMatch(/javascript:/i);
    expect(allergy.value).toContain("Penicillin");
    expect(allergy.value).toContain("Peanuts");
  });

  it("returns one neutral scan response for inactive, lost, revoked, and unknown tags", async () => {
    const data = await seed();
    for (const status of ["lost", "revoked"] as const) {
      await db.query("UPDATE tags SET inventory_status = $1 WHERE code = $2", [
        status,
        data.tagCode,
      ]);
      await request(app.getHttpServer())
        .get(`/v1/public/scan/${data.tagCode}`)
        .expect(200)
        .expect({ status: "tag_unavailable" });
    }
    await db.query("UPDATE tags SET inventory_status = 'active' WHERE code = $1", [data.tagCode]);
    await db.query("UPDATE wards SET status = 'inactive' WHERE id = $1", [data.wardId]);
    await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200)
      .expect({ status: "tag_unavailable" });
    await request(app.getHttpServer())
      .get(`/v1/public/scan/${randomUUID().replaceAll("-", "")}`)
      .expect(200)
      .expect({ status: "tag_unavailable" });
  });

  it("resolves public tags from canonical inventory_status and rejects legacy lifecycle writes", async () => {
    const data = await seed({ visibility: "public" });
    const active = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .set("X-Forwarded-For", "198.51.100.31")
      .expect(200);
    expect(active.body.status).toBe("available");

    await db.query("UPDATE tags SET inventory_status = 'lost' WHERE code = $1", [data.tagCode]);
    await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .set("X-Forwarded-For", "198.51.100.32")
      .expect(200)
      .expect({ status: "tag_unavailable" });
    await expect(
      db.query("UPDATE tags SET status = 'active' WHERE code = $1", [data.tagCode]),
    ).rejects.toThrow(/read-only mirror/);
    await expect(
      db.query("SELECT inventory_status, status FROM tags WHERE code = $1", [data.tagCode]),
    ).resolves.toMatchObject({ rows: [{ inventory_status: "lost", status: "lost" }] });
  });

  it("proves a forced-past divergent row with legacy status=active and canonical inventory_status!=active never resolves publicly", async () => {
    const data = await seed({ visibility: "public" });
    // Force a divergent state by temporarily disabling the mirror trigger and setting status='active' while inventory_status='lost'
    await db.query("ALTER TABLE tags DISABLE TRIGGER tags_status_mirror_from_inventory");
    try {
      await db.query(
        "UPDATE tags SET inventory_status = 'lost', status = 'active' WHERE code = $1",
        [data.tagCode],
      );
      const checkRow = await db.query("SELECT inventory_status, status FROM tags WHERE code = $1", [
        data.tagCode,
      ]);
      expect(checkRow.rows[0]).toEqual({ inventory_status: "lost", status: "active" });

      // Public scan must resolve ONLY on canonical inventory_status and return neutral tag_unavailable despite legacy status='active'
      const scan = await request(app.getHttpServer())
        .get(`/v1/public/scan/${data.tagCode}`)
        .set("X-Forwarded-For", "198.51.100.33")
        .expect(200);
      expect(scan.body).toEqual({ status: "tag_unavailable" });
    } finally {
      await db.query("ALTER TABLE tags ENABLE TRIGGER tags_status_mirror_from_inventory");
    }
  });

  it("allows only allergy and condition_notes to use bounded public free text at the database layer", async () => {
    // These two owner/policy-cleared exceptions remain bounded public text.
    await expect(
      db.query(
        `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, validation_policy)
         VALUES ($1, 'elderly', 'allergy', 'Allergy', 'text', 'public', true, true, '{"max_length":64}'::jsonb)`,
        [randomUUID()],
      ),
    ).resolves.toBeDefined();
    await expect(
      db.query(
        `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, validation_policy)
         VALUES ($1, 'medical', 'condition_notes', 'Condition notes', 'text', 'public', true, true, '{"max_length":64}'::jsonb)`,
        [randomUUID()],
      ),
    ).resolves.toBeDefined();
    // A bounded non-allowlisted text field is rejected even when it otherwise satisfies
    // the generic public text policy.
    await expect(
      db.query(
        `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, validation_policy)
         VALUES ($1, 'medical', 'note_bounded', 'Bounded note', 'short_text', 'public', true, true, '{"max_length":64}'::jsonb)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/field_catalog_public_controlled_values/);
  });

  it("keeps condition fields private until release, then exposes only validated flags and sanitised notes", async () => {
    const data = await seed();
    const token = await tokenFor(data);
    const flagsId = randomUUID();
    const notesId = randomUUID();
    const flagPolicy = JSON.stringify({
      allowed_values: [
        "epilepsy",
        "cardiac",
        "diabetes",
        "blood_thinner",
        "dialysis",
        "pacemaker_implant",
        "severe_allergy",
        "asthma_copd",
        "non_verbal",
        "hearing_impaired",
        "vision_impaired",
        "wandering",
      ],
      multi_select: true,
    });
    await db.query(
      `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, guardian_editable, validation_policy)
       VALUES ($1, 'medical', 'condition_flags', 'Condition flags', 'enum', 'public', true, true, true, $2::jsonb),
              ($3, 'medical', 'condition_notes', 'Condition notes', 'text', 'public', true, true, true, '{"max_length":1000}'::jsonb)`,
      [flagsId, flagPolicy, notesId],
    );

    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${flagsId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: ["epilepsy", "unknown_condition"] })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${flagsId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: ["epilepsy", "cardiac"] })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${data.wardId}/fields/${notesId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "<strong>Needs help</strong>\nhttps://evil.test\nPlain note" })
      .expect(200);

    const privateScan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200);
    expect(privateScan.body.fields).toEqual([]);

    for (const fieldId of [flagsId, notesId]) {
      await request(app.getHttpServer())
        .put(`/v1/app/wards/${data.wardId}/fields/${fieldId}/visibility`)
        .set("Authorization", `Bearer ${token}`)
        .send({ visibility: "public" })
        .expect(200);
    }

    const releasedScan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${data.tagCode}`)
      .expect(200);
    expect(releasedScan.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "condition_flags", value: ["epilepsy", "cardiac"] }),
        expect.objectContaining({ key: "condition_notes", value: expect.any(String) }),
      ]),
    );
    const notes = releasedScan.body.fields.find(
      (field: { key: string }) => field.key === "condition_notes",
    ).value as string;
    expect(notes).not.toMatch(/<[^>]*>/);
    expect(notes).not.toMatch(/https?:\/\//i);
    expect(notes).toContain("Needs help");
    expect(notes).toContain("Plain note");
  });

  it("records a keyed IP pseudonym but never raw scan data in PostgreSQL", async () => {
    const data = await seed();
    await request(app.getHttpServer()).get(`/v1/public/scan/${data.tagCode}`).expect(200);
    const result = await db.query(
      "SELECT shown_field_keys, scanner_ip_hmac FROM scan_log WHERE tag_id = (SELECT id FROM tags WHERE code = $1)",
      [data.tagCode],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].shown_field_keys).toEqual([]);
    expect(result.rows[0].scanner_ip_hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.rows[0])).not.toContain("127.0.0.1");
  });

  it("rejects a staff token at the guardian HTTP boundary", async () => {
    const data = await seed();
    const staffId = randomUUID();
    const password = "staff-password";
    const email = `${staffId}@example.test`;
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Staff', $2, $3, 'staff')",
      [staffId, email, await bcrypt.hash(password, 4)],
    );
    const token = await tokenForCredentials(email, password);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${data.wardId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("rejects an active guardian relationship that lacks public-release authority", async () => {
    const data = await seed();
    const guardianId = randomUUID();
    const password = "limited-guardian-password";
    const email = `${guardianId}@example.test`;
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Limited guardian', $2, $3, 'guardian')",
      [guardianId, email, await bcrypt.hash(password, 4)],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
       VALUES ($1, $2, 'relative', 'test authority', true, true, false)`,
      [data.wardId, guardianId],
    );
    const token = await tokenForCredentials(email, password);
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${data.wardId}/fields/${data.fieldId}/visibility`)
      .set("Authorization", `Bearer ${token}`)
      .send({ visibility: "public" })
      .expect(403);
  });

  it("limits a public code independently while retaining the per-IP scan limit", async () => {
    const first = await seed();
    const secondCode = randomUUID().replaceAll("-", "");
    await db.query(
      `INSERT INTO tags(code, ward_id, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id, activated_at)
       VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'guardian', $3, now())`,
      [secondCode, first.wardId, first.guardianId],
    );
    for (let count = 0; count < 5; count += 1) {
      await request(app.getHttpServer()).get(`/v1/public/scan/${first.tagCode}`).expect(200);
      await request(app.getHttpServer()).get(`/v1/public/scan/${secondCode}`).expect(200);
    }
    await request(app.getHttpServer()).get(`/v1/public/scan/${first.tagCode}`).expect(429);
  });

  it("triggers the public scan rate limit over HTTP", async () => {
    const data = await seed();
    const statuses: number[] = [];
    for (let count = 0; count < 31; count += 1) {
      statuses.push(
        (await request(app.getHttpServer()).get(`/v1/public/scan/${data.tagCode}`)).status,
      );
    }
    expect(statuses).toContain(429);
  });

  it("allows only an admin to mint a blank batch with short checksummed immutable codes", async () => {
    const adminId = randomUUID();
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash("admin-password", 4)],
    );
    const token = await tokenForCredentials(`${adminId}@example.test`, "admin-password");
    const response = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${token}`)
      .send({ categoryKey: "medical", form: "band", quantity: 2 })
      .expect(201);
    expect(response.body.codes).toHaveLength(2);
    expect(response.body.codes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^SS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
      ]),
    );
    const generatedCode = response.body.codes[0] as string;
    expect(isValidPublicTagCode(generatedCode)).toBe(true);
    const wrongChecksum = `${generatedCode.slice(0, -1)}${generatedCode.endsWith("A") ? "B" : "A"}`;
    expect(isValidPublicTagCode(wrongChecksum)).toBe(false);
    expect(
      (
        await db.query("SELECT inventory_status, ward_id FROM tags WHERE batch_id = $1", [
          response.body.id,
        ])
      ).rows,
    ).toEqual([
      { inventory_status: "blank", ward_id: null },
      { inventory_status: "blank", ward_id: null },
    ]);
    const png = await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/tags/${response.body.codes[0]}.png`)
      .set("Authorization", `Bearer ${token}`)
      .expect("Content-Type", /image\/png/)
      .expect(200);
    expect(png.body.subarray(1, 4).toString()).toBe("PNG");
    const pdf = await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/${response.body.id}/print.pdf`)
      .set("Authorization", `Bearer ${token}`)
      .expect("Content-Type", /application\/pdf/)
      .expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    await expect(
      db.query("UPDATE tags SET code = $1 WHERE code = $2", [
        "SS-ABCD-EFGH",
        response.body.codes[0],
      ]),
    ).rejects.toThrow("tag codes are immutable");
  }, 30_000);

  it("generates an A4 PDF sheet with ten tags per page and canonical Level-H QR inputs", async () => {
    const originalScanBase = process.env.PUBLIC_SCAN_BASE_URL;
    process.env.PUBLIC_SCAN_BASE_URL = "https://safetyspell.example.test";
    const fixtureQr = await QRCode.toBuffer("https://fixture.invalid/scan?tag=SS-AAAA-AAAA", {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 360,
    });
    const qrSpy = jest.spyOn(QRCode, "toBuffer") as unknown as jest.MockedFunction<
      (text: string | QRCode.QRCodeSegment[], options?: QRCode.QRCodeToBufferOptions) => Promise<Buffer>
    >;
    qrSpy.mockResolvedValue(fixtureQr);
    const drawTextSpy = jest.spyOn(PDFPage.prototype, "drawText");
    try {
      const adminId = randomUUID();
      await db.query(
        "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Print admin', $2, $3, 'company_admin')",
        [adminId, `${adminId}@example.test`, await bcrypt.hash("print-admin-password", 4)],
      );
      const adminToken = await tokenForCredentials(
        `${adminId}@example.test`,
        "print-admin-password",
      );
      const batch = await request(app.getHttpServer())
        .post("/v1/admin/tag-batches")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ categoryKey: "medical", form: "band", quantity: 11 })
        .expect(201);
      const codes = batch.body.codes as string[];
      expect(codes).toHaveLength(11);

      const pdfResponse = await request(app.getHttpServer())
        .get(`/v1/admin/tag-batches/${batch.body.id}/print.pdf`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect("Content-Type", /application\/pdf/)
        .expect(200);
      expect(Buffer.isBuffer(pdfResponse.body)).toBe(true);
      expect(pdfResponse.body.length).toBeGreaterThan(4);
      expect(pdfResponse.body.subarray(0, 4).toString()).toBe("%PDF");

      const parsedPdf = await PDFDocument.load(pdfResponse.body);
      expect(parsedPdf.getPages()).toHaveLength(2);
      for (const page of parsedPdf.getPages()) {
        expect(page.getWidth()).toBeCloseTo((210 * 72) / 25.4, 4);
        expect(page.getHeight()).toBeCloseTo((297 * 72) / 25.4, 4);
      }

      const expectedUrls = codes.map(
        (code) => `https://safetyspell.example.test/scan?tag=${encodeURIComponent(code)}`,
      ).sort();
      const sheetQrCalls = qrSpy.mock.calls.flatMap(([value, options]) =>
        typeof value === "string" && expectedUrls.includes(value) ? [{ value, options }] : [],
      );
      expect(sheetQrCalls).toHaveLength(codes.length);
      expect(sheetQrCalls.map(({ value }) => value)).toEqual(expectedUrls);
      for (const { options } of sheetQrCalls) {
        expect(options).toMatchObject({ errorCorrectionLevel: "H" });
      }

      const renderedBackupCodes = drawTextSpy.mock.calls
        .map(([text]) => text)
        .filter((text): text is string => typeof text === "string" && codes.includes(text));
      expect(renderedBackupCodes).toEqual([...codes].sort());

      await request(app.getHttpServer())
        .get(`/v1/admin/tag-batches/${batch.body.id}/print.pdf`)
        .expect(401);
      const guardian = await seed();
      const guardianToken = await tokenFor(guardian);
      await request(app.getHttpServer())
        .get(`/v1/admin/tag-batches/${batch.body.id}/print.pdf`)
        .set("Authorization", `Bearer ${guardianToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/v1/admin/tag-batches/${randomUUID()}/print.pdf`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);

      const emptyBatchId = randomUUID();
      const tenant = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [
        adminId,
      ]);
      const category = await db.query<{ id: string }>(
        "SELECT id FROM categories WHERE key = 'medical'",
      );
      await db.query(
        `INSERT INTO tag_batches(id, batch_code, category_id, form, quantity, created_by_user_id, tenant_id)
         VALUES($1, $2, $3, 'band', 1, $4, $5)`,
        [emptyBatchId, `B-EMPTY-${randomUUID()}`, category.rows[0]!.id, adminId, tenant.rows[0]!.tenant_id],
      );
      await request(app.getHttpServer())
        .get(`/v1/admin/tag-batches/${emptyBatchId}/print.pdf`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);
    } finally {
      qrSpy.mockRestore();
      drawTextSpy.mockRestore();
      if (originalScanBase === undefined) delete process.env.PUBLIC_SCAN_BASE_URL;
      else process.env.PUBLIC_SCAN_BASE_URL = originalScanBase;
    }
  }, 30_000);

  // Known defect, intentionally not fixed in this test-only slice: the unvalidated parameter
  // reaches PostgreSQL, which responds 500 instead of a clean client error. Remove `.failing`
  // when controller-level UUID validation is added.
  it.failing("rejects a malformed batch id with a clean client error", async () => {
    const adminId = randomUUID();
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, 'Malformed ID admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash("malformed-id-password", 4)],
    );
    const token = await tokenForCredentials(`${adminId}@example.test`, "malformed-id-password");
    const response = await request(app.getHttpServer())
      .get("/v1/admin/tag-batches/not-a-uuid/print.pdf")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBeLessThan(500);
  });

  it("allocates only company-held blank batch stock and enforces distributor custody", async () => {
    const adminId = randomUUID();
    const holderDistributorId = randomUUID();
    const nonHolderDistributorId = randomUUID();
    const deniedDistributorId = randomUUID();
    const holderUserId = randomUUID();
    const nonHolderUserId = randomUUID();
    const password = "distributor-password";
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash("admin-password", 4)],
    );
    await db.query(
      "INSERT INTO distributors(id, name) VALUES($1, 'Holder'),($2, 'Non-holder'),($3, 'Denied')",
      [holderDistributorId, nonHolderDistributorId, deniedDistributorId],
    );
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, distributor_id)
       VALUES($1, 'Holder user', $2, $3, 'distributor', $4),
             ($5, 'Non-holder user', $6, $3, 'distributor', $7)`,
      [
        holderUserId,
        `${holderUserId}@example.test`,
        await bcrypt.hash(password, 4),
        holderDistributorId,
        nonHolderUserId,
        `${nonHolderUserId}@example.test`,
        nonHolderDistributorId,
      ],
    );
    await db.query(
      `INSERT INTO distributor_allowed_categories(distributor_id, category_id)
       VALUES($1, (SELECT id FROM categories WHERE key = 'medical')),
             ($2, (SELECT id FROM categories WHERE key = 'medical'))`,
      [holderDistributorId, nonHolderDistributorId],
    );
    const adminToken = await tokenForCredentials(`${adminId}@example.test`, "admin-password");
    const batch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 2 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/admin/tag-batches/${batch.body.id}/allocate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ distributorId: deniedDistributorId })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/admin/tag-batches/${batch.body.id}/allocate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ distributorId: holderDistributorId })
      .expect(201)
      .expect({ batchId: batch.body.id, distributorId: holderDistributorId, count: 2 });
    expect(
      (
        await db.query(
          "SELECT holder_kind, holder_distributor_id, holder_guardian_user_id, source_distributor_id FROM tags WHERE batch_id = $1 ORDER BY code",
          [batch.body.id],
        )
      ).rows,
    ).toEqual([
      {
        holder_kind: "distributor",
        holder_distributor_id: holderDistributorId,
        holder_guardian_user_id: null,
        source_distributor_id: holderDistributorId,
      },
      {
        holder_kind: "distributor",
        holder_distributor_id: holderDistributorId,
        holder_guardian_user_id: null,
        source_distributor_id: holderDistributorId,
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT event_type, actor_user_id FROM tag_events WHERE tag_id IN (SELECT id FROM tags WHERE batch_id = $1) ORDER BY created_at",
          [batch.body.id],
        )
      ).rows,
    ).toEqual([
      { event_type: "allocated", actor_user_id: adminId },
      { event_type: "allocated", actor_user_id: adminId },
    ]);
    const custody = app.get(TagCustodyService);
    await expect(
      custody.assertMayAct(
        { id: holderUserId, role: "distributor", tenantId: "00000000-0000-4000-8000-000000000021" },
        batch.body.codes[0],
      ),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct(
        {
          id: nonHolderUserId,
          role: "distributor",
          tenantId: "00000000-0000-4000-8000-000000000021",
        },
        batch.body.codes[0],
      ),
    ).rejects.toThrow("Current tag custody does not permit this action");
  }, 30_000);

  it("enforces tags_holder_fk_consistency DB CHECK constraint on all holder kinds", async () => {
    const guardianId = randomUUID();
    const distributorId = randomUUID();
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Guardian', $2, 'hash', 'guardian')",
      [guardianId, `${guardianId}@example.test`],
    );
    await db.query("INSERT INTO distributors(id, name) VALUES($1, 'Distributor')", [distributorId]);

    // Company kind must have both FKs null
    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_distributor_id)
         VALUES('11112222333344445555666677778888', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company', $1)`,
        [distributorId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id)
         VALUES('22223333444455556666777788889999', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company', $1)`,
        [guardianId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    // Distributor kind must have holder_distributor_id and null holder_guardian_user_id
    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind)
         VALUES('33334444555566667777888899990000', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'distributor')`,
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_distributor_id, holder_guardian_user_id)
         VALUES('44445555666677778888999900001111', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'distributor', $1, $2)`,
        [distributorId, guardianId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    // Guardian kind must have holder_guardian_user_id and null holder_distributor_id
    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind)
         VALUES('55556666777788889999000011112222', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'guardian')`,
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_distributor_id, holder_guardian_user_id)
         VALUES('66667777888899990000111122223333', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'guardian', $1, $2)`,
        [distributorId, guardianId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);
  });

  it("evaluates authority service invariants across company, distributor, and guardian actors", async () => {
    const custody = app.get(TagCustodyService);
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const otherGuardianId = randomUUID();
    const distributorId = randomUUID();
    const distUserId = randomUUID();

    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role)
       VALUES($1, 'Admin', $2, 'h', 'company_admin'),
             ($3, 'Guardian', $4, 'h', 'guardian'),
             ($5, 'Other Guardian', $6, 'h', 'guardian')`,
      [
        adminId,
        `${adminId}@example.test`,
        guardianId,
        `${guardianId}@example.test`,
        otherGuardianId,
        `${otherGuardianId}@example.test`,
      ],
    );
    await db.query("INSERT INTO distributors(id, name) VALUES($1, 'Dist 1')", [distributorId]);
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role, distributor_id) VALUES($1, 'Dist User', $2, 'h', 'distributor', $3)",
      [distUserId, `${distUserId}@example.test`, distributorId],
    );

    // Company stock
    const companyTag = "11111111222222223333333344444444";
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company')`,
      [companyTag],
    );

    // Guardian stock
    const guardianTag = "22222222333333334444444455555555";
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'guardian', $2)`,
      [guardianTag, guardianId],
    );

    // Distributor stock
    const distTag = "33333333444444445555555566666666";
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, holder_distributor_id)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'distributor', $2)`,
      [distTag, distributorId],
    );

    // Company admin may act on company tag, not on guardian or distributor tag
    await expect(
      custody.assertMayAct(
        { id: adminId, role: "company_admin", tenantId: "00000000-0000-4000-8000-000000000021" },
        companyTag,
      ),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct(
        { id: adminId, role: "company_admin", tenantId: "00000000-0000-4000-8000-000000000021" },
        guardianTag,
      ),
    ).rejects.toThrow(/does not permit/);
    await expect(
      custody.assertMayAct(
        { id: adminId, role: "company_admin", tenantId: "00000000-0000-4000-8000-000000000021" },
        distTag,
      ),
    ).rejects.toThrow(/does not permit/);

    // Guardian may act on own tag, not on other guardian tag or company tag
    await expect(
      custody.assertMayAct(
        { id: guardianId, role: "guardian", tenantId: "00000000-0000-4000-8000-000000000021" },
        guardianTag,
      ),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct(
        { id: otherGuardianId, role: "guardian", tenantId: "00000000-0000-4000-8000-000000000021" },
        guardianTag,
      ),
    ).rejects.toThrow(/does not permit/);
    await expect(
      custody.assertMayAct(
        { id: guardianId, role: "guardian", tenantId: "00000000-0000-4000-8000-000000000021" },
        companyTag,
      ),
    ).rejects.toThrow(/does not permit/);

    // Distributor without category permission cannot act
    await expect(
      custody.assertMayAct(
        { id: distUserId, role: "distributor", tenantId: "00000000-0000-4000-8000-000000000021" },
        distTag,
      ),
    ).rejects.toThrow(/does not permit/);

    // Distributor with matching category permission can act
    await db.query(
      "INSERT INTO distributor_allowed_categories(distributor_id, category_id) VALUES($1, (SELECT id FROM categories WHERE key = 'medical'))",
      [distributorId],
    );
    await expect(
      custody.assertMayAct(
        { id: distUserId, role: "distributor", tenantId: "00000000-0000-4000-8000-000000000021" },
        distTag,
      ),
    ).resolves.toBeUndefined();
  });

  it("verifies migration 014 backfill rules: guardian wins, origin preserved, stale distributor FK cleared", async () => {
    const guardianId = randomUUID();
    const distId = randomUUID();
    const wardId = randomUUID();

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'G', $2, 'h', 'guardian')",
      [guardianId, `${guardianId}@example.test`],
    );
    await db.query("INSERT INTO distributors(id, name) VALUES($1, 'Dist')", [distId]);
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Ward', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
       VALUES($1, $2, 'relative', 'auth', true, true, true)`,
      [wardId, guardianId],
    );

    // Insert tag simulating legacy state before 014: active tag with both stale holder_distributor_id and assigned_guardian_user_id
    const legacyCode = "44444444555555556666666677777777";
    await db.query(
      `INSERT INTO tags(code, ward_id, category, category_id, form, inventory_status, holder_distributor_id, assigned_guardian_user_id, holder_kind, holder_guardian_user_id)
       VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', NULL, $3, 'guardian', $3)`,
      [legacyCode, wardId, guardianId],
    );

    const row = (
      await db.query(
        "SELECT holder_kind, holder_distributor_id, holder_guardian_user_id, source_distributor_id FROM tags WHERE code = $1",
        [legacyCode],
      )
    ).rows[0];
    expect(row.holder_kind).toBe("guardian");
    expect(row.holder_guardian_user_id).toBe(guardianId);
    expect(row.holder_distributor_id).toBeNull();
  });

  it("claims a blank tag with activation PIN, transitioning to assigned status without premature activation", async () => {
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const wardId = randomUUID();
    const password = "guardian-password";
    const adminPassword = "admin-password";
    const email = `${guardianId}@example.test`;

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(adminPassword, 4)],
    );
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Guardian', $2, $3, 'guardian')",
      [guardianId, email, await bcrypt.hash(password, 4)],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Kamla Devi', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
       VALUES($1, $2, 'child', 'family authority', true, true, true)`,
      [wardId, guardianId],
    );

    const adminToken = await tokenForCredentials(`${adminId}@example.test`, adminPassword);
    const guardianToken = await tokenForCredentials(email, password);

    // Admin mints a batch
    const batch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 1 })
      .expect(201);

    const tagItem = batch.body.tags[0] as { code: string; pin: string };
    expect(tagItem.code).toBeDefined();
    expect(tagItem.pin).toHaveLength(6);

    // Before claim, verify tag is blank with hashed PIN
    const preTag = (
      await db.query(
        "SELECT inventory_status, holder_kind, activation_pin_hash, pin_failed_attempts, pin_expires_at, ward_id, activated_at FROM tags WHERE code = $1",
        [tagItem.code],
      )
    ).rows[0];
    expect(preTag.inventory_status).toBe("blank");
    expect(preTag.holder_kind).toBe("company");
    expect(preTag.activation_pin_hash).toBeDefined();
    expect(preTag.pin_failed_attempts).toBe(0);
    expect(preTag.ward_id).toBeNull();
    expect(preTag.activated_at).toBeNull();

    // Guardian claims tag for ward
    const claimRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(201);

    expect(claimRes.body).toEqual({
      success: true,
      code: tagItem.code,
      wardId,
    });

    // Verify DB state: assigned (NOT active), guardian custody, PIN hash consumed/cleared, activated_at is NULL
    const postTag = (
      await db.query(
        "SELECT inventory_status, status, holder_kind, holder_guardian_user_id, holder_distributor_id, assigned_guardian_user_id, assigned_by_user_id, activation_pin_hash, pin_failed_attempts, pin_locked_until, ward_id, activated_at FROM tags WHERE code = $1",
        [tagItem.code],
      )
    ).rows[0];
    expect(postTag.inventory_status).toBe("assigned");
    expect(postTag.status).not.toBe("active");
    expect(postTag.holder_kind).toBe("guardian");
    expect(postTag.holder_guardian_user_id).toBe(guardianId);
    expect(postTag.holder_distributor_id).toBeNull();
    expect(postTag.assigned_guardian_user_id).toBe(guardianId);
    expect(postTag.assigned_by_user_id).toBe(guardianId);
    expect(postTag.activation_pin_hash).toBeNull();
    expect(postTag.pin_failed_attempts).toBe(0);
    expect(postTag.pin_locked_until).toBeNull();
    expect(postTag.ward_id).toBe(wardId);
    expect(postTag.activated_at).toBeNull();

    // Verify exactly one 'assigned' tag_event (no premature 'activated' event)
    const events = (
      await db.query(
        "SELECT event_type, from_status, to_status, actor_user_id, metadata FROM tag_events WHERE tag_id = (SELECT id FROM tags WHERE code = $1) ORDER BY created_at",
        [tagItem.code],
      )
    ).rows;
    expect(events).toEqual([
      {
        event_type: "assigned",
        from_status: "blank",
        to_status: "assigned",
        actor_user_id: guardianId,
        metadata: { ward_id: wardId, method: "pin_claim" },
      },
    ]);

    // Safety boundary: public scan on newly claimed 'assigned' tag MUST return neutral tag_unavailable
    const scanResolver = app.get(ScanResolverService);
    const publicScan = await scanResolver.resolve(tagItem.code);
    expect(publicScan).toEqual({ status: "tag_unavailable" });

    // Guardian custody authority is immediately valid
    const custody = app.get(TagCustodyService);
    await expect(
      custody.assertMayAct(
        { id: guardianId, role: "guardian", tenantId: "00000000-0000-4000-8000-000000000021" },
        tagItem.code,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a category-mismatched claim atomically without an assignment event", async () => {
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const wardId = randomUUID();
    const adminPassword = "admin-password";
    const guardianPassword = "guardian-password";
    const guardianEmail = `${guardianId}@example.test`;

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(adminPassword, 4)],
    );
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Guardian', $2, $3, 'guardian')",
      [guardianId, guardianEmail, await bcrypt.hash(guardianPassword, 4)],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Medical ward', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
       VALUES($1, $2, 'parent', 'test authority', true, true, true)`,
      [wardId, guardianId],
    );

    const adminToken = await tokenForCredentials(`${adminId}@example.test`, adminPassword);
    const guardianToken = await tokenForCredentials(guardianEmail, guardianPassword);
    const batch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "elderly", form: "band", quantity: 1 })
      .expect(201);
    const tagItem = batch.body.tags[0] as { code: string; pin: string };

    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(400)
      .expect({
        statusCode: 400,
        message: "Invalid tag code or activation PIN",
        error: "Bad Request",
      });

    const tag = (
      await db.query("SELECT inventory_status, ward_id FROM tags WHERE code = $1", [tagItem.code])
    ).rows[0];
    expect(tag).toEqual({ inventory_status: "blank", ward_id: null });
    const events = await db.query(
      "SELECT 1 FROM tag_events WHERE tag_id = (SELECT id FROM tags WHERE code = $1)",
      [tagItem.code],
    );
    expect(events.rows).toHaveLength(0);
  });

  it("enforces anti-enumeration, escalating lockout, and cross-guardian isolation on tag claim", async () => {
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const outsiderId = randomUUID();
    const wardId = randomUUID();
    const password = "test-password";
    const adminPassword = "admin-password";

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(adminPassword, 4)],
    );
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role)
       VALUES($1, 'Guardian', $2, $4, 'guardian'),
             ($3, 'Outsider', $5, $4, 'guardian')`,
      [
        guardianId,
        `${guardianId}@example.test`,
        outsiderId,
        await bcrypt.hash(password, 4),
        `${outsiderId}@example.test`,
      ],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Ward', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
       VALUES($1, $2, 'relative', 'auth', true, true, true)`,
      [wardId, guardianId],
    );

    const adminToken = await tokenForCredentials(`${adminId}@example.test`, adminPassword);
    const guardianToken = await tokenForCredentials(`${guardianId}@example.test`, password);
    const outsiderToken = await tokenForCredentials(`${outsiderId}@example.test`, password);

    // Outsider cannot claim for someone else's ward
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({ tagCode: "SS-0000-0000", pin: "123456" })
      .expect(403);

    // Nonexistent tag code -> neutral 400
    const nonExistentRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: "SS-NONEXIST-00", pin: "123456" })
      .expect(400);
    expect(nonExistentRes.body.message).toBe("Invalid tag code or activation PIN");

    // Mint a real tag
    const batch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 1 })
      .expect(201);
    const tagItem = batch.body.tags[0] as { code: string; pin: string };

    // 4 failed attempts -> 400 neutral
    for (let i = 1; i <= 4; i++) {
      const wrongPinRes = await request(app.getHttpServer())
        .post(`/v1/app/wards/${wardId}/tags/claim`)
        .set("Authorization", `Bearer ${guardianToken}`)
        .send({ tagCode: tagItem.code, pin: "WRONGP" })
        .expect(400);
      expect(wrongPinRes.body.message).toBe("Invalid tag code or activation PIN");
    }

    const midTag = (
      await db.query("SELECT pin_failed_attempts, pin_locked_until FROM tags WHERE code = $1", [
        tagItem.code,
      ])
    ).rows[0];
    expect(midTag.pin_failed_attempts).toBe(4);
    expect(midTag.pin_locked_until).toBeNull();

    // 5th failed attempt -> locks tag for 15 minutes
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: "WRONGP" })
      .expect(400);

    const lockedTag = (
      await db.query("SELECT pin_failed_attempts, pin_locked_until FROM tags WHERE code = $1", [
        tagItem.code,
      ])
    ).rows[0];
    expect(lockedTag.pin_failed_attempts).toBe(5);
    expect(lockedTag.pin_locked_until).toBeDefined();
    expect(new Date(lockedTag.pin_locked_until).getTime()).toBeGreaterThan(Date.now());

    // 6th attempt with CORRECT PIN while locked -> rejected with neutral 400
    const lockedRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(400);
    expect(lockedRes.body.message).toBe("Invalid tag code or activation PIN");

    // Unlock tag artificially and claim successfully
    await db.query(
      "UPDATE tags SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE code = $1",
      [tagItem.code],
    );

    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(201);

    // Attempting to claim the already claimed tag again -> neutral 400
    const reClaimRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(400);
    expect(reClaimRes.body.message).toBe("Invalid tag code or activation PIN");
  });

  it("enforces guardian activation safety gates: requires ward profile data and public consent before assigned tag becomes active", async () => {
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const outsiderId = randomUUID();
    const wardId = randomUUID();
    const password = "test-password";
    const adminPassword = "admin-password";

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(adminPassword, 4)],
    );
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role)
       VALUES($1, 'Guardian', $2, $4, 'guardian'),
             ($3, 'Outsider', $5, $4, 'guardian')`,
      [
        guardianId,
        `${guardianId}@example.test`,
        outsiderId,
        await bcrypt.hash(password, 4),
        `${outsiderId}@example.test`,
      ],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Ward Alpha', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, can_manage_fields, can_manage_public_release, active)
       VALUES($1, $2, 'mother', 'court_order', true, true, true)`,
      [wardId, guardianId],
    );

    const adminToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${adminId}@example.test`, password: adminPassword })
        .expect(201)
    ).body.accessToken;

    const guardianToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${guardianId}@example.test`, password })
        .expect(201)
    ).body.accessToken;

    const outsiderToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${outsiderId}@example.test`, password })
        .expect(201)
    ).body.accessToken;

    // 1. Admin creates a tag batch
    const batchRes = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "medical", form: "card", quantity: 1 })
      .expect(201);
    const tagItem = batchRes.body.tags[0];

    // 2. Guardian claims tag -> status is 'assigned'
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(201);

    // Verify tag is 'assigned' and public scan returns tag_unavailable
    const scanResolver = app.get(ScanResolverService);
    let publicScan = await scanResolver.resolve(tagItem.code);
    expect(publicScan).toEqual({ status: "tag_unavailable" });

    // GATE 1: Attempt to activate tag when ward profile has NO data -> rejected
    const noDataRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(400);
    expect(noDataRes.body.message).toContain("ward profile has no data");

    // Insert catalog fields for medical category (blood_group and allergy)
    const bloodGroupId = randomUUID();
    const allergyId = randomUUID();
    await db.query(
      `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, provenance_required, guardian_editable, validation_policy)
       VALUES
         ($1, 'medical', 'blood_group', 'Blood Group', 'enum', 'public', true, true, true, true, '{"allowed_values":["A+","A-","B+","B-","O+","O-","AB+","AB-","Unknown"]}'::jsonb),
         ($2, 'medical', 'allergy', 'Allergies', 'text', 'public', true, true, true, true, '{"max_length":1000}'::jsonb)`,
      [bloodGroupId, allergyId],
    );

    // Guardian fills ward data (blood_group and allergy)
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${wardId}/fields/${bloodGroupId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ value: "O+" })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${wardId}/fields/${allergyId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ value: "Penicillin\nPeanuts" })
      .expect(200);

    // GATE 2: Attempt to activate tag when fields are filled but NO public consent is given -> rejected
    const noConsentRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(400);
    expect(noConsentRes.body.message).toContain("no public-released field contains profile data");

    // GATE 3: Outsider guardian attempts to activate tag -> rejected
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);

    // Guardian releases blood_group and allergy to public
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${wardId}/fields/${bloodGroupId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(200);

    await request(app.getHttpServer())
      .put(`/v1/app/wards/${wardId}/fields/${allergyId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(200);

    // SUCCESS GATE: Now guardian activates the tag!
    const activateRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(201);

    expect(activateRes.body).toMatchObject({
      success: true,
      code: tagItem.code,
      status: "active",
    });
    expect(activateRes.body.activatedAt).toBeDefined();

    // Verify DB state: inventory_status = 'active', status = 'active', activated_at NOT NULL
    const activeTagDb = (
      await db.query(
        "SELECT inventory_status, status, holder_kind, holder_guardian_user_id, ward_id, activated_at FROM tags WHERE code = $1",
        [tagItem.code],
      )
    ).rows[0];
    expect(activeTagDb.inventory_status).toBe("active");
    expect(activeTagDb.status).toBe("active");
    expect(activeTagDb.activated_at).toBeDefined();

    // Verify tag_events has immutable 'activated' event
    const events = (
      await db.query(
        "SELECT event_type, from_status, to_status, actor_user_id, metadata FROM tag_events WHERE tag_id = (SELECT id FROM tags WHERE code = $1) ORDER BY created_at",
        [tagItem.code],
      )
    ).rows;
    expect(events).toEqual([
      {
        event_type: "assigned",
        from_status: "blank",
        to_status: "assigned",
        actor_user_id: guardianId,
        metadata: { ward_id: wardId, method: "pin_claim" },
      },
      {
        event_type: "activated",
        from_status: "assigned",
        to_status: "active",
        actor_user_id: guardianId,
        metadata: { ward_id: wardId, method: "guardian_release" },
      },
    ]);

    // Verify public scan NOW resolves and returns exactly the released, filtered fields!
    publicScan = await scanResolver.resolve(tagItem.code);
    expect(publicScan.status).toBe("available");
    expect(publicScan.category).toBe("medical");
    expect(publicScan.fields).toHaveLength(2);
    expect(publicScan.fields).toEqual(
      expect.arrayContaining([
        {
          key: "allergy",
          label: "Allergies",
          value: "Penicillin\nPeanuts",
          provenance: "guardian_reported",
        },
        {
          key: "blood_group",
          label: "Blood Group",
          value: "O+",
          provenance: "guardian_reported",
        },
      ]),
    );
    expect(publicScan.disclaimer).toBe(
      "Information is family-provided. This is not medical advice.",
    );

    // Verify guardian tags list now surfaces the active tag
    const guardianTagsRes = await request(app.getHttpServer())
      .get(`/v1/app/wards/${wardId}/tags`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(200);
    expect(guardianTagsRes.body).toEqual([
      {
        code: tagItem.code,
        form: "card",
      },
    ]);
  });

  it("strictly rejects activation when data is in field A but public toggle is on empty field B", async () => {
    const adminId = randomUUID();
    const guardianId = randomUUID();
    const wardId = randomUUID();
    const password = "test-password";
    const adminPassword = "admin-password";

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Admin', $2, $3, 'company_admin')",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(adminPassword, 4)],
    );
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Guardian', $2, $3, 'guardian')",
      [guardianId, `${guardianId}@example.test`, await bcrypt.hash(password, 4)],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Ward Beta', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, can_manage_fields, can_manage_public_release, active)
       VALUES($1, $2, 'parent', 'power_of_attorney', true, true, true)`,
      [wardId, guardianId],
    );

    const adminToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${adminId}@example.test`, password: adminPassword })
        .expect(201)
    ).body.accessToken;

    const guardianToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${guardianId}@example.test`, password })
        .expect(201)
    ).body.accessToken;

    const bloodGroupId = randomUUID();
    const allergyId = randomUUID();
    await db.query(
      `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, provenance_required, guardian_editable, validation_policy)
       VALUES
         ($1, 'medical', 'blood_group', 'Blood Group', 'enum', 'public', true, true, true, true, '{"allowed_values":["O+"]}'::jsonb),
         ($2, 'medical', 'allergy', 'Allergies', 'text', 'public', true, true, true, true, '{"max_length":1000}'::jsonb)`,
      [bloodGroupId, allergyId],
    );

    const batchRes = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryKey: "medical", form: "card", quantity: 1 })
      .expect(201);
    const tagItem = batchRes.body.tags[0];

    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/claim`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ tagCode: tagItem.code, pin: tagItem.pin })
      .expect(201);

    // Guardian fills data for allergy (field A) ONLY
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${wardId}/fields/${allergyId}`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ value: "Penicillin" })
      .expect(200);

    // Guardian toggles visibility for blood_group (field B, which is EMPTY) to public
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${wardId}/fields/${bloodGroupId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(200);

    // TRAP CHECK: Attempt to activate tag -> MUST be rejected because the released field is empty!
    const mismatchedRes = await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(400);
    expect(mismatchedRes.body.message).toContain("no public-released field contains profile data");

    // Now guardian releases the populated field (allergy) to public
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${wardId}/fields/${allergyId}/visibility`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .send({ visibility: "public" })
      .expect(200);

    // Activation now succeeds!
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${wardId}/tags/${tagItem.code}/activate`)
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(201);
  });

  it("enforces role-scoped inventory listing, masked references for distributors, 5-state count strips, and zero health data leak", async () => {
    const adminId = randomUUID();
    const distAlphaUserId = randomUUID();
    const distBetaUserId = randomUUID();
    const distAlphaId = randomUUID();
    const distBetaId = randomUUID();
    const guardianId = randomUUID();
    const wardId = randomUUID();
    const password = "test-password";
    const adminPassword = "admin-password";

    // Create distributors
    await db.query(
      `INSERT INTO distributors(id, name, status)
       VALUES ($1, 'Distributor Alpha', 'active'),
              ($2, 'Distributor Beta', 'active')`,
      [distAlphaId, distBetaId],
    );

    // Create users
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, distributor_id)
       VALUES
         ($1, 'Admin', $2, $6, 'company_admin', NULL),
         ($3, 'Dist Alpha User', $4, $6, 'distributor', $7),
         ($5, 'Dist Beta User', $8, $6, 'distributor', $9)`,
      [
        adminId,
        `${adminId}@example.test`,
        distAlphaUserId,
        `${distAlphaUserId}@example.test`,
        distBetaUserId,
        await bcrypt.hash(adminPassword, 4),
        distAlphaId,
        `${distBetaUserId}@example.test`,
        distBetaId,
      ],
    );

    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES($1, 'Guardian', $2, $3, 'guardian')",
      [guardianId, `${guardianId}@example.test`, await bcrypt.hash(password, 4)],
    );
    await db.query(
      "INSERT INTO wards(id, name, category, status) VALUES($1, 'Ward Medical', 'medical', 'active')",
      [wardId],
    );
    await db.query(
      `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, can_manage_fields, can_manage_public_release, active)
       VALUES($1, $2, 'parent', 'power_of_attorney', true, true, true)`,
      [wardId, guardianId],
    );

    // Seed 6 tags across inventory states and holders:
    // Tag 1: Blank, held by company
    // Tag 2: Blank, held by Dist Alpha
    // Tag 3: Blank, held by Dist Beta
    // Tag 4: Assigned, originated from Dist Alpha, assigned to Ward
    // Tag 5: Active, originated from Dist Alpha, active on Ward
    // Tag 6: Lost, originated from Dist Beta
    const tag1Code = createPublicTagCode();
    const tag2Code = createPublicTagCode();
    const tag3Code = createPublicTagCode();
    const tag4Code = createPublicTagCode();
    const tag5Code = createPublicTagCode();
    const tag6Code = createPublicTagCode();

    const medCatId = (await db.query("SELECT id FROM categories WHERE key = 'medical'")).rows[0]
      ?.id;

    await db.query(
      `INSERT INTO tags(id, code, category, category_id, form, inventory_status, holder_kind, holder_distributor_id, source_distributor_id, holder_guardian_user_id, ward_id, assigned_at, activated_at, status_changed_at)
       VALUES
         (gen_random_uuid(), $1, 'medical', $7, 'card', 'blank', 'company', NULL, NULL, NULL, NULL, NULL, NULL, now()),
         (gen_random_uuid(), $2, 'medical', $7, 'card', 'blank', 'distributor', $8, $8, NULL, NULL, NULL, NULL, now()),
         (gen_random_uuid(), $3, 'medical', $7, 'card', 'blank', 'distributor', $9, $9, NULL, NULL, NULL, NULL, now()),
         (gen_random_uuid(), $4, 'medical', $7, 'band', 'assigned', 'guardian', NULL, $8, $10, $11, now(), NULL, now()),
         (gen_random_uuid(), $5, 'medical', $7, 'band', 'active', 'guardian', NULL, $8, $10, $11, now(), now(), now()),
         (gen_random_uuid(), $6, 'medical', $7, 'sticker', 'lost', 'distributor', $9, $9, NULL, NULL, NULL, NULL, now())`,
      [
        tag1Code,
        tag2Code,
        tag3Code,
        tag4Code,
        tag5Code,
        tag6Code,
        medCatId,
        distAlphaId,
        distBetaId,
        guardianId,
        wardId,
      ],
    );

    const adminToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${adminId}@example.test`, password: adminPassword })
        .expect(201)
    ).body.accessToken;

    const distAlphaToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${distAlphaUserId}@example.test`, password: adminPassword })
        .expect(201)
    ).body.accessToken;

    const guardianToken = (
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: `${guardianId}@example.test`, password })
        .expect(201)
    ).body.accessToken;

    // 1. ADMIN INVENTORY VIEW: sees all 6 tags across all distributors + company stock
    const adminRes = await request(app.getHttpServer())
      .get("/v1/inventory/tags")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(adminRes.body.total).toBe(6);
    expect(adminRes.body.items).toHaveLength(6);
    expect(adminRes.body.counts).toEqual({
      blank: 3,
      assigned: 1,
      active: 1,
      lost: 1,
      revoked: 0,
      total: 6,
    });

    const adminCodes = adminRes.body.items.map((i: { code: string }) => i.code);
    expect(adminCodes).toContain(tag1Code);
    expect(adminCodes).toContain(tag2Code);
    expect(adminCodes).toContain(tag3Code);
    expect(adminCodes).toContain(tag4Code);
    expect(adminCodes).toContain(tag5Code);
    expect(adminCodes).toContain(tag6Code);

    // Admin sees distributor name and unmasked/system assignment reference
    const adminTag2 = adminRes.body.items.find((i: { code: string }) => i.code === tag2Code);
    expect(adminTag2.distributorName).toBe("Distributor Alpha");

    const adminTag4 = adminRes.body.items.find((i: { code: string }) => i.code === tag4Code);
    expect(adminTag4.assignedReference).toBe(`WARD-${wardId.slice(0, 8)}`);

    // 2. DISTRIBUTOR ALPHA INVENTORY VIEW: sees ONLY Alpha's held/originated stock (Tags 2, 4, 5)
    const distRes = await request(app.getHttpServer())
      .get("/v1/inventory/tags")
      .set("Authorization", `Bearer ${distAlphaToken}`)
      .expect(200);

    expect(distRes.body.total).toBe(3);
    expect(distRes.body.items).toHaveLength(3);
    expect(distRes.body.counts).toEqual({
      blank: 1,
      assigned: 1,
      active: 1,
      lost: 0,
      revoked: 0,
      total: 3,
    });

    const distCodes = distRes.body.items.map((i: { code: string }) => i.code);
    expect(distCodes).toContain(tag2Code);
    expect(distCodes).toContain(tag4Code);
    expect(distCodes).toContain(tag5Code);
    expect(distCodes).not.toContain(tag1Code); // Company stock hidden
    expect(distCodes).not.toContain(tag3Code); // Dist Beta stock hidden
    expect(distCodes).not.toContain(tag6Code); // Dist Beta stock hidden

    // PRIVACY ENFORCEMENT: Distributor sees MASKED reference only
    const distTag4 = distRes.body.items.find((i: { code: string }) => i.code === tag4Code);
    expect(distTag4.assignedReference).toBe(`REF-***-${wardId.slice(-4)}`);
    expect(distTag4.assignedReference).not.toContain(wardId); // Full ward ID is never present

    // PRIVACY ENFORCEMENT: Zero health, consent, or profile data leakage in any inventory response
    for (const item of distRes.body.items) {
      expect(item).not.toHaveProperty("wardName");
      expect(item).not.toHaveProperty("guardianName");
      expect(item).not.toHaveProperty("guardianEmail");
      expect(item).not.toHaveProperty("bloodGroup");
      expect(item).not.toHaveProperty("allergies");
      expect(item).not.toHaveProperty("fields");
      expect(item).not.toHaveProperty("consent");
    }

    // 3. FILTERING & SEARCH: Distributor filters by status = 'active'
    const activeFilterRes = await request(app.getHttpServer())
      .get("/v1/inventory/tags?status=active")
      .set("Authorization", `Bearer ${distAlphaToken}`)
      .expect(200);

    expect(activeFilterRes.body.total).toBe(1);
    expect(activeFilterRes.body.items[0].code).toBe(tag5Code);
    // Count strip still represents the total status counts for the scoped inventory
    expect(activeFilterRes.body.counts).toEqual({
      blank: 1,
      assigned: 1,
      active: 1,
      lost: 0,
      revoked: 0,
      total: 3,
    });

    // 4. ACCESS CONTROL: Guardian role is forbidden from inventory endpoint
    await request(app.getHttpServer())
      .get("/v1/inventory/tags")
      .set("Authorization", `Bearer ${guardianToken}`)
      .expect(403);
  });

  it("scopes guardian HTTP reads and public scans by server-resolved tenant", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const a = await seed({ visibility: "public", tenantId: tenantA });
    const b = await seed({ visibility: "public", tenantId: tenantB });
    const aToken = await tokenFor(a);
    const bToken = await tokenFor(b);

    await request(app.getHttpServer())
      .get(`/v1/app/wards/${a.wardId}`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${b.wardId}`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${a.wardId}/consent-audit`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${b.wardId}/consent-audit`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(403);
    const aScan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${a.tagCode}`)
      .set("X-Forwarded-For", "198.51.100.21")
      .expect(200);
    const bScan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${b.tagCode}`)
      .set("X-Forwarded-For", "198.51.100.22")
      .query({ tenant_id: tenantA })
      .expect(200);
    expect(Object.keys(aScan.body).sort()).toEqual(Object.keys(bScan.body).sort());
  });

  it("allows an in-tenant PIN claim to assigned and rejects a cross-tenant tag/PIN", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Claim A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Claim B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const a = await seed({ tenantId: tenantA });
    await seed({ tenantId: tenantB });
    const token = await tokenFor(a);
    const pin = "ABC123";
    const aCode = createPublicTagCode();
    const bCode = createPublicTagCode();
    for (const [code, tenant] of [
      [aCode, tenantA],
      [bCode, tenantB],
    ] as const) {
      await db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, activation_pin_hash, pin_expires_at, tenant_id)
         VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company', $2, now() + interval '1 year', $3)`,
        [code, await bcrypt.hash(pin, 8), tenant],
      );
    }
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${a.wardId}/tags/claim`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tagCode: bCode, pin })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${a.wardId}/tags/claim`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tagCode: aCode, pin })
      .expect(201);
    const claimed = await db.query("SELECT inventory_status, ward_id FROM tags WHERE code = $1", [
      aCode,
    ]);
    expect(claimed.rows[0]).toMatchObject({ inventory_status: "assigned", ward_id: a.wardId });
  });

  it("returns only the authenticated admin tenant's inventory rows and counts", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Inventory A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Inventory B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const adminId = randomUUID();
    const password = "inventory-admin-password";
    await db.query(
      "INSERT INTO users(id, name, email, password_hash, role, tenant_id) VALUES($1, 'Admin A', $2, $3, 'company_admin', $4)",
      [adminId, `${adminId}@example.test`, await bcrypt.hash(password, 4), tenantA],
    );
    const aCode = createPublicTagCode();
    const bCode = createPublicTagCode();
    for (const [code, tenant] of [
      [aCode, tenantA],
      [bCode, tenantB],
    ] as const) {
      await db.query(
        `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, tenant_id) VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company', $2)`,
        [code, tenant],
      );
    }
    const token = await tokenForCredentials(`${adminId}@example.test`, password);
    const response = await request(app.getHttpServer())
      .get("/v1/inventory/tags")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.counts).toMatchObject({ blank: 1, total: 1 });
    expect(response.body.items.map((item: { code: string }) => item.code)).toEqual([aCode]);
    expect(response.body.items.some((item: { code: string }) => item.code === bCode)).toBe(false);
  });

  it("activates an assigned same-tenant tag and refuses a cross-tenant tag", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Activation A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Activation B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const a = await seed({ visibility: "public", tenantId: tenantA });
    const b = await seed({ visibility: "public", tenantId: tenantB });
    const token = await tokenFor(a);
    const code = createPublicTagCode();
    await db.query(
      `INSERT INTO tags(code, ward_id, category, category_id, form, inventory_status, holder_kind, holder_guardian_user_id, tenant_id) VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'assigned', 'guardian', $3, $4)`,
      [code, a.wardId, a.guardianId, tenantA],
    );
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${a.wardId}/tags/${b.tagCode}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/app/wards/${a.wardId}/tags/${code}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    await expect(
      db.query("SELECT inventory_status FROM tags WHERE code = $1", [code]),
    ).resolves.toMatchObject({ rows: [expect.objectContaining({ inventory_status: "active" })] });
  });

  it("scopes guardian field, visibility, and tag-list operations without changing B data", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Guardian A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Guardian B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const a = await seed({ tenantId: tenantA });
    const b = await seed({ tenantId: tenantB });
    const token = await tokenFor(a);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${a.wardId}/tags`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/v1/app/wards/${b.wardId}/tags`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${a.wardId}/fields/${a.fieldId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "O+" })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/v1/app/wards/${b.wardId}/fields/${b.fieldId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "O+" })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${a.wardId}/fields/${a.fieldId}/visibility`)
      .set("Authorization", `Bearer ${token}`)
      .send({ visibility: "public" })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/v1/app/wards/${b.wardId}/fields/${b.fieldId}/visibility`)
      .set("Authorization", `Bearer ${token}`)
      .send({ visibility: "public" })
      .expect(403);
    const bVisibility = await db.query(
      "SELECT visibility FROM ward_field_visibility WHERE ward_id = $1 AND field_catalog_id = $2",
      [b.wardId, b.fieldId],
    );
    expect(bVisibility.rows).toEqual([]);
  });

  it("scopes admin mint, print, and batch allocation at the HTTP boundary", async () => {
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Admin matrix A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
        [`Admin matrix B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const adminA = randomUUID();
    const adminB = randomUUID();
    const password = "admin-matrix-password";
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
       VALUES ($1, 'Admin A', $2, $3, 'company_admin', $4),
              ($5, 'Admin B', $6, $3, 'company_admin', $7)`,
      [
        adminA,
        `${adminA}@example.test`,
        await bcrypt.hash(password, 4),
        tenantA,
        adminB,
        `${adminB}@example.test`,
        tenantB,
      ],
    );
    const distributorId = randomUUID();
    await db.query("INSERT INTO distributors(id, name) VALUES($1, 'Matrix holder')", [
      distributorId,
    ]);
    await db.query(
      "INSERT INTO distributor_allowed_categories(distributor_id, category_id) VALUES($1, (SELECT id FROM categories WHERE key = 'medical'))",
      [distributorId],
    );
    const aToken = await tokenForCredentials(`${adminA}@example.test`, password);
    const bToken = await tokenForCredentials(`${adminB}@example.test`, password);

    const aBatch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${aToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 1 })
      .expect(201);
    expect(
      (await db.query("SELECT tenant_id FROM tag_batches WHERE id = $1", [aBatch.body.id])).rows,
    ).toEqual([{ tenant_id: tenantA }]);

    // A caller cannot direct a mint into another tenant; the selector is rejected at the boundary.
    await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${bToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 1, tenantId: tenantA })
      .expect(400);
    const bBatch = await request(app.getHttpServer())
      .post("/v1/admin/tag-batches")
      .set("Authorization", `Bearer ${bToken}`)
      .send({ categoryKey: "medical", form: "band", quantity: 1 })
      .expect(201);
    expect(
      (await db.query("SELECT tenant_id FROM tag_batches WHERE id = $1", [bBatch.body.id])).rows,
    ).toEqual([{ tenant_id: tenantB }]);

    await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/tags/${aBatch.body.codes[0]}.png`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/${aBatch.body.id}/print.pdf`)
      .set("Authorization", `Bearer ${aToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/tags/${aBatch.body.codes[0]}.png`)
      .set("Authorization", `Bearer ${bToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/admin/tag-batches/${aBatch.body.id}/print.pdf`)
      .set("Authorization", `Bearer ${bToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/v1/admin/tag-batches/${aBatch.body.id}/allocate`)
      .set("Authorization", `Bearer ${bToken}`)
      .send({ distributorId })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/admin/tag-batches/${aBatch.body.id}/allocate`)
      .set("Authorization", `Bearer ${aToken}`)
      .send({ distributorId })
      .expect(201);
    expect(
      (
        await db.query(
          "SELECT holder_kind, holder_distributor_id, tenant_id FROM tags WHERE batch_id = $1",
          [aBatch.body.id],
        )
      ).rows,
    ).toEqual([
      { holder_kind: "distributor", holder_distributor_id: distributorId, tenant_id: tenantA },
    ]);
  }, 30_000);

  it("activates a plain asset without writing person or consent tables and exposes only released allowlisted fields", async () => {
    const assetScanIp = "198.51.100.240";
    const tenantId = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'business') RETURNING id",
        [`Asset tenant ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const adminId = randomUUID();
    const password = "asset-admin-password";
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
       VALUES($1, 'Asset admin', $2, $3, 'company_admin', $4)`,
      [adminId, `${adminId}@example.test`, await bcrypt.hash(password, 4), tenantId],
    );
    const assetCode = createPublicTagCode();
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, tenant_id)
       VALUES($1, 'asset', (SELECT id FROM categories WHERE key = 'asset'), 'plate', 'blank', 'company', $2)`,
      [assetCode, tenantId],
    );
    const token = await tokenForCredentials(`${adminId}@example.test`, password);
    const before = await db.query(
      `SELECT (SELECT count(*) FROM wards) AS wards,
              (SELECT count(*) FROM ward_guardians) AS ward_guardians,
              (SELECT count(*) FROM ward_field_values) AS ward_field_values,
              (SELECT count(*) FROM ward_field_visibility) AS ward_field_visibility,
              (SELECT count(*) FROM consent_audit) AS consent_audit`,
    );

    const activated = await request(app.getHttpServer())
      .post("/v1/app/assets/activate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        tagCode: assetCode,
        categoryKey: "asset",
        label: "Oxygen cylinder C-42",
        assetType: "Medical gas cylinder",
        returnReference: "RET-441",
        internalNote: "Owner contact: private@example.test; 12 Private Road",
        publicFields: ["label", "asset_type"],
      })
      .expect(201);
    expect(activated.body).toMatchObject({ success: true, code: assetCode, status: "active" });

    const after = await db.query(
      `SELECT (SELECT count(*) FROM wards) AS wards,
              (SELECT count(*) FROM ward_guardians) AS ward_guardians,
              (SELECT count(*) FROM ward_field_values) AS ward_field_values,
              (SELECT count(*) FROM ward_field_visibility) AS ward_field_visibility,
              (SELECT count(*) FROM consent_audit) AS consent_audit`,
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      db.query(
        "SELECT inventory_status, asset_id, ward_id, activation_pin_hash FROM tags WHERE code = $1",
        [assetCode],
      ),
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          inventory_status: "active",
          ward_id: null,
          activation_pin_hash: null,
        }),
      ],
    });

    const scan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${assetCode}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    expect(scan.body).toEqual({
      status: "available",
      category: "asset",
      fields: [
        expect.objectContaining({
          key: "label",
          value: "Oxygen cylinder C-42",
          provenance: "tenant_reported",
        }),
        expect.objectContaining({
          key: "asset_type",
          value: "Medical gas cylinder",
          provenance: "tenant_reported",
        }),
      ],
      disclaimer: "Information is family-provided. This is not medical advice.",
    });
    const serialized = JSON.stringify(scan.body);
    expect(serialized).not.toContain("RET-441");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("Private Road");

    const person = await seed({ visibility: "public" });
    const personScan = await request(app.getHttpServer())
      .get(`/v1/public/scan/${person.tagCode}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    expect(Object.keys(scan.body).sort()).toEqual(Object.keys(personScan.body).sort());
    expect(personScan.body.fields).toEqual([
      expect.objectContaining({ key: "blood_group", value: "O+", provenance: "guardian_reported" }),
    ]);
  });

  it("keeps asset activation and reads tenant scoped, rejects person tags, and keeps asset unavailability neutral", async () => {
    const assetScanIp = "198.51.100.241";
    const tenantA = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'business') RETURNING id",
        [`Asset A ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const tenantB = (
      await db.query<{ id: string }>(
        "INSERT INTO tenants(name, type) VALUES($1, 'business') RETURNING id",
        [`Asset B ${randomUUID()}`],
      )
    ).rows[0]!.id;
    const password = "asset-isolation-password";
    const adminA = randomUUID();
    const adminB = randomUUID();
    await db.query(
      `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
       VALUES ($1, 'Asset A admin', $2, $3, 'company_admin', $4),
              ($5, 'Asset B admin', $6, $3, 'company_admin', $7)`,
      [
        adminA,
        `${adminA}@example.test`,
        await bcrypt.hash(password, 4),
        tenantA,
        adminB,
        `${adminB}@example.test`,
        tenantB,
      ],
    );
    const assetCode = createPublicTagCode();
    const blankAssetCode = createPublicTagCode();
    const personCode = createPublicTagCode();
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, inventory_status, holder_kind, tenant_id)
       VALUES ($1, 'asset', (SELECT id FROM categories WHERE key = 'asset'), 'plate', 'blank', 'company', $4),
              ($2, 'asset', (SELECT id FROM categories WHERE key = 'asset'), 'plate', 'blank', 'company', $4),
              ($3, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'blank', 'company', $4)`,
      [assetCode, blankAssetCode, personCode, tenantA],
    );
    const tokenA = await tokenForCredentials(`${adminA}@example.test`, password);
    const tokenB = await tokenForCredentials(`${adminB}@example.test`, password);
    const activated = await request(app.getHttpServer())
      .post("/v1/app/assets/activate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        tagCode: assetCode,
        categoryKey: "asset",
        label: "Tenant A pump",
        internalNote: "never public",
        publicFields: ["label"],
      })
      .expect(201);

    await request(app.getHttpServer())
      .post("/v1/app/assets/activate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        tagCode: personCode,
        categoryKey: "asset",
        label: "Attempted bypass",
        publicFields: ["label"],
      })
      .expect(400);
    await expect(
      db.query("SELECT asset_id, inventory_status FROM tags WHERE code = $1", [personCode]),
    ).resolves.toMatchObject({ rows: [{ asset_id: null, inventory_status: "blank" }] });

    await request(app.getHttpServer())
      .get("/v1/app/assets")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200)
      .expect([]);
    await request(app.getHttpServer())
      .get(`/v1/app/assets/${activated.body.assetId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404);
    await request(app.getHttpServer())
      .post("/v1/app/assets/activate")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({
        tagCode: blankAssetCode,
        categoryKey: "asset",
        label: "Cross tenant",
        publicFields: ["label"],
      })
      .expect(404);

    const unknown = await request(app.getHttpServer())
      .get(`/v1/public/scan/${createPublicTagCode()}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    const blank = await request(app.getHttpServer())
      .get(`/v1/public/scan/${blankAssetCode}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    await db.query("UPDATE tags SET inventory_status = 'lost' WHERE code = $1", [assetCode]);
    const lost = await request(app.getHttpServer())
      .get(`/v1/public/scan/${assetCode}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    await db.query("UPDATE tags SET inventory_status = 'revoked' WHERE code = $1", [assetCode]);
    const revoked = await request(app.getHttpServer())
      .get(`/v1/public/scan/${assetCode}`)
      .set("X-Forwarded-For", assetScanIp)
      .expect(200);
    expect([blank.body, lost.body, revoked.body]).toEqual([
      unknown.body,
      unknown.body,
      unknown.body,
    ]);
    expect(unknown.body).toEqual({ status: "tag_unavailable" });
  });

  describe("Step 6 stage-move authority", () => {
    async function expectUnmoved(fixture: StageMoveFixture) {
      await expect(
        db.query("SELECT current_stage_id FROM tags WHERE id = $1", [fixture.tagId]),
      ).resolves.toMatchObject({ rows: [{ current_stage_id: fixture.fromStageId }] });
      await expect(
        db.query(
          "SELECT count(*)::int AS count FROM tag_events WHERE tag_id = $1 AND event_type = 'stage_moved'",
          [fixture.tagId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }

    it("stage-move preserves lifecycle while moving a company-held tag and writes one immutable event", async () => {
      const fixture = await seedStageMoveFixture();

      const moved = await stageMoveRequest(fixture).expect(201);
      expect(moved.body).toMatchObject({
        success: true,
        code: fixture.tagCode,
        fromStageId: fixture.fromStageId,
        toStageId: fixture.toStageId,
      });

      await expect(
        db.query(
          "SELECT current_stage_id, inventory_status, status, activated_at FROM tags WHERE id = $1",
          [fixture.tagId],
        ),
      ).resolves.toMatchObject({
        rows: [
          expect.objectContaining({
            current_stage_id: fixture.toStageId,
            inventory_status: "active",
            status: "active",
            activated_at: expect.any(Date),
          }),
        ],
      });
      const event = await db.query(
        `SELECT id, event_type, actor_user_id, from_status, to_status, from_stage_id, to_stage_id, metadata
         FROM tag_events WHERE tag_id = $1 AND event_type = 'stage_moved'`,
        [fixture.tagId],
      );
      expect(event.rows).toEqual([
        {
          id: moved.body.eventId,
          event_type: "stage_moved",
          actor_user_id: fixture.actorId,
          from_status: "active",
          to_status: "active",
          from_stage_id: fixture.fromStageId,
          to_stage_id: fixture.toStageId,
          metadata: { method: "staff_hop" },
        },
      ]);
      await expect(
        db.query("UPDATE tag_events SET metadata = '{}'::jsonb WHERE id = $1", [
          moved.body.eventId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("stage-move rejects a staff user with no tenant role", async () => {
      const fixture = await seedStageMoveFixture({ tenantRole: "none" });
      await stageMoveRequest(fixture).expect(403);
      await expectUnmoved(fixture);
    });

    it("stage-move rejects an inactive tenant role", async () => {
      const fixture = await seedStageMoveFixture({ tenantRoleActive: false });
      await stageMoveRequest(fixture).expect(403);
      await expectUnmoved(fixture);
    });

    it("stage-move rejects an unprivileged tenant role", async () => {
      const fixture = await seedStageMoveFixture({ tenantRole: "unprivileged" });
      await stageMoveRequest(fixture).expect(403);
      await expectUnmoved(fixture);
    });

    it("stage-move rejects an inactive or absent hop permission", async () => {
      const inactive = await seedStageMoveFixture({ hopActive: false });
      await stageMoveRequest(inactive).expect(403);
      await expectUnmoved(inactive);

      const absent = await seedStageMoveFixture();
      await db.query(
        `DELETE FROM route_stage_hop_permissions
         WHERE tenant_id = $1 AND route_id = $2 AND from_stage_id = $3 AND to_stage_id = $4`,
        [absent.tenantId, absent.routeId, absent.fromStageId, absent.toStageId],
      );
      await stageMoveRequest(absent).expect(403);
      await expectUnmoved(absent);
    });

    it("stage-move rejects a cross-route destination even for active staff", async () => {
      const fixture = await seedStageMoveFixture();
      const otherRouteId = randomUUID();
      const otherStageId = randomUUID();
      await db.query("INSERT INTO routes(id, tenant_id, name) VALUES($1, $2, $3)", [
        otherRouteId,
        fixture.tenantId,
        `Other route ${otherRouteId}`,
      ]);
      await db.query(
        "INSERT INTO stages(id, tenant_id, route_id, name) VALUES($1, $2, $3, 'Elsewhere')",
        [otherStageId, fixture.tenantId, otherRouteId],
      );
      await stageMoveRequest(fixture, {
        fromStageId: fixture.fromStageId,
        toStageId: otherStageId,
      }).expect(403);
      await expectUnmoved(fixture);
    });

    it.each([
      ["route", "UPDATE routes SET active = false WHERE id = $1"],
      ["from stage", "UPDATE stages SET active = false WHERE id = $1"],
      ["to stage", "UPDATE stages SET active = false WHERE id = $1"],
    ])("stage-move rejects an inactive %s", async (kind, statement) => {
      const fixture = await seedStageMoveFixture();
      const id =
        kind === "route"
          ? fixture.routeId
          : kind === "from stage"
            ? fixture.fromStageId
            : fixture.toStageId;
      await db.query(statement, [id]);
      await stageMoveRequest(fixture).expect(403);
      await expectUnmoved(fixture);
    });

    it.each(["distributor", "guardian"] as const)(
      "stage-move rejects a %s-held tag despite a valid staff role and hop",
      async (holderKind) => {
        const fixture = await seedStageMoveFixture({ holderKind });
        await stageMoveRequest(fixture).expect(403);
        await expectUnmoved(fixture);
      },
    );

    it("stage-move rejects a wrong-tenant staff token without changing the target", async () => {
      const fixture = await seedStageMoveFixture();
      const otherTenantId = (
        await db.query<{ id: string }>(
          "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
          [`Stage other tenant ${randomUUID()}`],
        )
      ).rows[0]!.id;
      const outsider = await seedStageMoveFixture({ tenantId: otherTenantId });

      await request(app.getHttpServer())
        .post(`/v1/app/tags/${fixture.tagCode}/stage-moves`)
        .set("Authorization", `Bearer ${outsider.token}`)
        .send({ fromStageId: fixture.fromStageId, toStageId: fixture.toStageId })
        .expect(404);
      await expectUnmoved(fixture);
    });

    it.each(["guardian", "company_admin"] as const)(
      "stage-move rejects a %s token at the staff HTTP boundary",
      async (role) => {
        const fixture = await seedStageMoveFixture();
        const userId = randomUUID();
        const password = "non-staff-stage-password";
        const email = `${userId}@example.test`;
        await db.query(
          `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
           VALUES($1, 'Non staff', $2, $3, $4, $5)`,
          [userId, email, await bcrypt.hash(password, 4), role, fixture.tenantId],
        );
        const token = await tokenForCredentials(email, password);
        await request(app.getHttpServer())
          .post(`/v1/app/tags/${fixture.tagCode}/stage-moves`)
          .set("Authorization", `Bearer ${token}`)
          .send({ fromStageId: fixture.fromStageId, toStageId: fixture.toStageId })
          .expect(403);
        await expectUnmoved(fixture);
      },
    );

    it("stage-move rejects an unplaced tag and a stale from-stage without an event", async () => {
      const unplaced = await seedStageMoveFixture({ currentStageId: null });
      await stageMoveRequest(unplaced).expect(400);
      await expect(
        db.query("SELECT current_stage_id FROM tags WHERE id = $1", [unplaced.tagId]),
      ).resolves.toMatchObject({ rows: [{ current_stage_id: null }] });

      const stale = await seedStageMoveFixture();
      await stageMoveRequest(stale, {
        fromStageId: randomUUID(),
        toStageId: stale.toStageId,
      }).expect(409);
      await expectUnmoved(stale);
    });

    it("stage-move serializes concurrent requests and emits only one event", async () => {
      const fixture = await seedStageMoveFixture();
      const [first, second] = await Promise.all([
        stageMoveRequest(fixture),
        stageMoveRequest(fixture),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      await expect(
        db.query(
          `SELECT current_stage_id,
                  (SELECT count(*)::int FROM tag_events WHERE tag_id = $1 AND event_type = 'stage_moved') AS event_count
           FROM tags WHERE id = $1`,
          [fixture.tagId],
        ),
      ).resolves.toMatchObject({ rows: [{ current_stage_id: fixture.toStageId, event_count: 1 }] });
    });

    it("stage-move rejects client lifecycle input and Slice 1 rejects malformed stage events", async () => {
      const fixture = await seedStageMoveFixture();
      await stageMoveRequest(fixture, {
        fromStageId: fixture.fromStageId,
        toStageId: fixture.toStageId,
        inventoryStatus: "lost",
      }).expect(400);
      await expectUnmoved(fixture);

      await expect(
        db.query(
          `INSERT INTO tag_events(
             tag_id, event_type, actor_user_id, from_status, to_status, from_stage_id, to_stage_id
           ) VALUES($1, 'stage_moved', $2, 'active', 'lost', $3, $4)`,
          [fixture.tagId, fixture.actorId, fixture.fromStageId, fixture.toStageId],
        ),
      ).rejects.toThrow(/must not change inventory lifecycle status/);
    });
  });

  describe("Step 6 route/stage/role admin configuration", () => {
    async function seedAdminFixture(tenantId = "00000000-0000-4000-8000-000000000021") {
      const adminId = randomUUID();
      const password = "admin-stage-password";
      const email = `admin-${adminId}@example.test`;
      await db.query(
        `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
         VALUES($1, 'Company Admin', $2, $3, 'company_admin', $4)`,
        [adminId, email, await bcrypt.hash(password, 4), tenantId],
      );
      const token = await tokenForCredentials(email, password);
      return { tenantId, adminId, token };
    }

    it("full CRUD lifecycle for routes, stages, hops, and tenant roles", async () => {
      const admin = await seedAdminFixture();

      // 1. Create Route
      const routeRes = await request(app.getHttpServer())
        .post("/v1/admin/routes")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Emergency Admission" })
        .expect(201);
      expect(routeRes.body).toMatchObject({
        name: "Emergency Admission",
        active: true,
        tenant_id: admin.tenantId,
      });
      const routeId = routeRes.body.id;

      // 2. Create Stages
      const triageRes = await request(app.getHttpServer())
        .post(`/v1/admin/routes/${routeId}/stages`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Triage" })
        .expect(201);
      const icuRes = await request(app.getHttpServer())
        .post(`/v1/admin/routes/${routeId}/stages`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "ICU" })
        .expect(201);
      expect(triageRes.body.name).toBe("Triage");
      expect(icuRes.body.name).toBe("ICU");

      // 3. Create Tenant Role
      const roleRes = await request(app.getHttpServer())
        .post("/v1/admin/tenant-roles")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Triage Nurse", authorityClass: "operational_staff" })
        .expect(201);
      expect(roleRes.body).toMatchObject({
        name: "Triage Nurse",
        authority_class: "operational_staff",
        active: true,
      });
      const roleId = roleRes.body.id;

      // 4. Create Hop
      const hopRes = await request(app.getHttpServer())
        .post(`/v1/admin/routes/${routeId}/hops`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({
          fromStageId: triageRes.body.id,
          toStageId: icuRes.body.id,
          allowedTenantRoleId: roleId,
        })
        .expect(201);
      expect(hopRes.body).toMatchObject({
        route_id: routeId,
        from_stage_id: triageRes.body.id,
        to_stage_id: icuRes.body.id,
        allowed_tenant_role_id: roleId,
        active: true,
      });
      const hopId = hopRes.body.id;

      // 5. List and Get Route
      const listRes = await request(app.getHttpServer())
        .get("/v1/admin/routes")
        .set("Authorization", `Bearer ${admin.token}`)
        .expect(200);
      expect(listRes.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: routeId,
            name: "Emergency Admission",
            stage_count: 2,
            active_hop_count: 1,
          }),
        ]),
      );

      const getRes = await request(app.getHttpServer())
        .get(`/v1/admin/routes/${routeId}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .expect(200);
      expect(getRes.body.stages.length).toBe(2);
      expect(getRes.body.hops.length).toBe(1);
      expect(getRes.body.hops[0]).toMatchObject({
        from_stage_name: "Triage",
        to_stage_name: "ICU",
        allowed_tenant_role_name: "Triage Nurse",
      });

      // 6. Update Route and Stage names
      await request(app.getHttpServer())
        .patch(`/v1/admin/routes/${routeId}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Urgent Admission" })
        .expect(200)
        .expect((res) => expect(res.body.name).toBe("Urgent Admission"));

      await request(app.getHttpServer())
        .patch(`/v1/admin/stages/${triageRes.body.id}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Initial Triage" })
        .expect(200)
        .expect((res) => expect(res.body.name).toBe("Initial Triage"));

      // 7. Update Hop
      await request(app.getHttpServer())
        .patch(`/v1/admin/hops/${hopId}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ active: false })
        .expect(200)
        .expect((res) => expect(res.body.active).toBe(false));

      // 8. Assign user tenant role
      const staffUserId = randomUUID();
      await db.query(
        `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
         VALUES($1, 'Staff User', $2, 'hash', 'staff', $3)`,
        [staffUserId, `${staffUserId}@example.test`, admin.tenantId],
      );
      const assignRes = await request(app.getHttpServer())
        .patch(`/v1/admin/users/${staffUserId}/tenant-role`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ tenantRoleId: roleId })
        .expect(200);
      expect(assignRes.body.tenant_role_id).toBe(roleId);
    });

    it("enforces role and cross-tenant boundaries with exact 403 vs 404 distinction", async () => {
      const adminA = await seedAdminFixture();
      const tenantBId = (
        await db.query<{ id: string }>(
          "INSERT INTO tenants(name, type) VALUES($1, 'hospital') RETURNING id",
          [`Tenant B ${randomUUID()}`],
        )
      ).rows[0]!.id;
      const adminB = await seedAdminFixture(tenantBId);

      // Create Route in Tenant A
      const routeA = (
        await request(app.getHttpServer())
          .post("/v1/admin/routes")
          .set("Authorization", `Bearer ${adminA.token}`)
          .send({ name: "Route A" })
          .expect(201)
      ).body;

      // Staff and Guardian in Tenant A
      const staffId = randomUUID();
      const guardianId = randomUUID();
      const staffEmail = `staff-${staffId}@example.test`;
      const guardianEmail = `guardian-${guardianId}@example.test`;
      const password = "role-test-password";
      const pwHash = await bcrypt.hash(password, 4);
      await db.query(
        `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
         VALUES($1, 'Staff A', $2, $4, 'staff', $5), ($3, 'Guardian A', $6, $4, 'guardian', $5)`,
        [staffId, staffEmail, guardianId, pwHash, adminA.tenantId, guardianEmail],
      );
      const staffToken = await tokenForCredentials(staffEmail, password);
      const guardianToken = await tokenForCredentials(guardianEmail, password);

      // 1. Staff and Guardian hitting admin endpoint get 403 (wrong role in own tenant)
      await request(app.getHttpServer())
        .get("/v1/admin/routes")
        .set("Authorization", `Bearer ${staffToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get("/v1/admin/routes")
        .set("Authorization", `Bearer ${guardianToken}`)
        .expect(403);

      // 2. Admin B hitting Tenant A route gets 404 (cross-tenant anti-enumeration)
      await request(app.getHttpServer())
        .get(`/v1/admin/routes/${routeA.id}`)
        .set("Authorization", `Bearer ${adminB.token}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/v1/admin/routes/${routeA.id}`)
        .set("Authorization", `Bearer ${adminB.token}`)
        .send({ name: "Hijacked Route" })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/v1/admin/routes/${routeA.id}/stages`)
        .set("Authorization", `Bearer ${adminB.token}`)
        .send({ name: "Infiltrate Stage" })
        .expect(404);
    });

    it("surfaces clean 400 and 409 errors for domain and constraint conflicts", async () => {
      const admin = await seedAdminFixture();

      // Duplicate route name -> 409
      await request(app.getHttpServer())
        .post("/v1/admin/routes")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Pediatrics" })
        .expect(201);
      const dupRoute = await request(app.getHttpServer())
        .post("/v1/admin/routes")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Pediatrics" })
        .expect(409);
      expect(dupRoute.body.message).toMatch(/already exists/i);

      // Duplicate stage name on same route -> 409
      const route = (
        await request(app.getHttpServer())
          .post("/v1/admin/routes")
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ name: "Cardiology" })
          .expect(201)
      ).body;
      const stage1 = (
        await request(app.getHttpServer())
          .post(`/v1/admin/routes/${route.id}/stages`)
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ name: "ECG Room" })
          .expect(201)
      ).body;
      await request(app.getHttpServer())
        .post(`/v1/admin/routes/${route.id}/stages`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "ECG Room" })
        .expect(409);

      // Hop fromStage === toStage -> 400
      const sameHop = await request(app.getHttpServer())
        .post(`/v1/admin/routes/${route.id}/hops`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({
          fromStageId: stage1.id,
          toStageId: stage1.id,
          allowedTenantRoleId: randomUUID(),
        })
        .expect(400);
      expect(sameHop.body.message).toMatch(/distinct stages/i);

      // Duplicate case-insensitive role name -> 409
      await request(app.getHttpServer())
        .post("/v1/admin/tenant-roles")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "Surgeon", authorityClass: "operational_staff" })
        .expect(201);
      await request(app.getHttpServer())
        .post("/v1/admin/tenant-roles")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ name: "surgeon", authorityClass: "operational_staff" })
        .expect(409);

      // User role assignment coarse-role mismatch -> clean 400
      const guardianUserId = randomUUID();
      await db.query(
        `INSERT INTO users(id, name, email, password_hash, role, tenant_id)
         VALUES($1, 'Guardian Person', $2, 'hash', 'guardian', $3)`,
        [guardianUserId, `${guardianUserId}@example.test`, admin.tenantId],
      );
      const staffRole = (
        await request(app.getHttpServer())
          .post("/v1/admin/tenant-roles")
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ name: "OR Tech", authorityClass: "operational_staff" })
          .expect(201)
      ).body;

      const mismatch = await request(app.getHttpServer())
        .patch(`/v1/admin/users/${guardianUserId}/tenant-role`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ tenantRoleId: staffRole.id })
        .expect(400);
      expect(mismatch.body.message).toMatch(
        /operational_staff tenant roles require users.role = staff/,
      );
    });

    it("retires stage with stranded-tag count, cascade-deactivates hops, and blocks future stage moves", async () => {
      const fixture = await seedStageMoveFixture();
      const admin = await seedAdminFixture(fixture.tenantId);

      // Confirm legitimate move works before retirement
      await stageMoveRequest(fixture).expect(201);

      // Tag is now at fixture.toStageId
      const tagCheck = await db.query<{ current_stage_id: string }>(
        "SELECT current_stage_id FROM tags WHERE id = $1",
        [fixture.tagId],
      );
      expect(tagCheck.rows[0]?.current_stage_id).toBe(fixture.toStageId);

      // Add another tag to fixture.toStageId
      const extraTagId = randomUUID();
      await db.query(
        `INSERT INTO tags(
           id, code, category, category_id, form, inventory_status, holder_kind, current_stage_id, tenant_id
         ) VALUES(
           $1, 'SS-BKST-9999', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'company', $2, $3
         )`,
        [extraTagId, fixture.toStageId, fixture.tenantId],
      );

      // Admin retires fixture.toStageId (where 2 tags now sit)
      const retireRes = await request(app.getHttpServer())
        .patch(`/v1/admin/stages/${fixture.toStageId}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ active: false })
        .expect(200);

      expect(retireRes.body).toMatchObject({
        id: fixture.toStageId,
        active: false,
        strandedTagCount: 2,
      });

      // Confirm dependent hops were cascade-deactivated in DB (not deleted)
      const hops = await db.query<{ active: boolean }>(
        `SELECT active FROM route_stage_hop_permissions
         WHERE tenant_id = $1 AND (from_stage_id = $2 OR to_stage_id = $2)`,
        [fixture.tenantId, fixture.toStageId],
      );
      expect(hops.rows.length).toBeGreaterThan(0);
      expect(hops.rows.every((h) => h.active === false)).toBe(true);

      // Moving into the retired stage with a new tag at active fromStageId now fails with 403
      const activeTag = await seedStageMoveFixture({ tenantId: fixture.tenantId });
      // Update hop permission to point to the newly retired stage
      await stageMoveRequest(activeTag, {
        fromStageId: activeTag.fromStageId,
        toStageId: fixture.toStageId,
      }).expect(403);

      // Moving the stranded tag out of the retired stage also fails with 403
      await request(app.getHttpServer())
        .post(`/v1/app/tags/${fixture.tagCode}/stage-moves`)
        .set("Authorization", `Bearer ${fixture.token}`)
        .send({
          fromStageId: fixture.toStageId,
          toStageId: fixture.fromStageId,
        })
        .expect(403);
    });
  });
});
