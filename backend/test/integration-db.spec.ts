import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApi } from "../src/bootstrap";
import { isValidPublicTagCode } from "../src/domain/tag-code";
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
  options: { visibility?: "private" | "public"; approved?: boolean; publicEligible?: boolean } = {},
): Promise<Seed> {
  const guardianId = randomUUID();
  const wardId = randomUUID();
  const fieldId = randomUUID();
  const tagCode = randomUUID().replaceAll("-", "");
  const password = "integration-password";
  await db.query(
    "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'guardian')",
    [
      guardianId,
      "Integration guardian",
      `${guardianId}@example.test`,
      await bcrypt.hash(password, 4),
    ],
  );
  await db.query(
    "INSERT INTO wards(id, category, name) VALUES ($1, 'medical', 'Integration ward')",
    [wardId],
  );
  await db.query(
    `INSERT INTO ward_guardians(ward_id, user_id, relationship, authority_basis, active, can_manage_fields, can_manage_public_release)
     VALUES ($1, $2, 'parent', 'test authority', true, true, true)`,
    [wardId, guardianId],
  );
  await db.query(
    `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, approved_by, approved_at, validation_policy)
     VALUES ($1, 'medical', 'blood_group', 'Blood group', 'enum', 'public', $2, $3, $4, now(), '{"allowed_values":["O+"]}'::jsonb)`,
    [fieldId, options.publicEligible ?? true, options.approved ?? true, guardianId],
  );
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
    `INSERT INTO tags(code, ward_id, category, category_id, form, status, inventory_status, holder_kind, holder_guardian_user_id, activated_at)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'active', 'guardian', $3, now())`,
    [tagCode, wardId, guardianId],
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
    `INSERT INTO tags(code, ward_id, category, category_id, form, status, inventory_status, holder_kind, holder_guardian_user_id, activated_at)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'active', 'guardian', $3, now())`,
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
  ]);
  const tables = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  expect(tables.rows.map((row) => row.tablename)).toEqual(
    expect.arrayContaining([
      "consent_audit",
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
      await db.query("UPDATE tags SET status = $1 WHERE code = $2", [status, data.tagCode]);
      await request(app.getHttpServer())
        .get(`/v1/public/scan/${data.tagCode}`)
        .expect(200)
        .expect({ status: "tag_unavailable" });
    }
    await db.query("UPDATE tags SET status = 'active' WHERE code = $1", [data.tagCode]);
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

  it("accepts bounded public free text but rejects unbounded public free text at the database layer", async () => {
    // Bounded public free text is now permitted (the allergy capability). approved_by/approved_at
    // stay NULL together for an owner/policy-cleared field.
    await expect(
      db.query(
        `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, validation_policy)
         VALUES ($1, 'medical', 'note_bounded', 'Bounded note', 'short_text', 'public', true, true, '{"max_length":64}'::jsonb)`,
        [randomUUID()],
      ),
    ).resolves.toBeDefined();
    // Public free text must carry a finite, in-range length bound: an over-large cap is rejected.
    await expect(
      db.query(
        `INSERT INTO field_catalog(id, category, field_key, label, data_type, max_level, public_eligible, approved, validation_policy)
         VALUES ($1, 'medical', 'note_oversized', 'Oversized note', 'short_text', 'public', true, true, '{"max_length":5000}'::jsonb)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/field_catalog_text_bound/);
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
      `INSERT INTO tags(code, ward_id, category, category_id, form, status, inventory_status, holder_kind, holder_guardian_user_id, activated_at)
       VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'active', 'guardian', $3, now())`,
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
      custody.assertMayAct({ id: holderUserId, role: "distributor" }, batch.body.codes[0]),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct({ id: nonHolderUserId, role: "distributor" }, batch.body.codes[0]),
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
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_distributor_id)
         VALUES('11112222333344445555666677778888', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'company', $1)`,
        [distributorId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_guardian_user_id)
         VALUES('22223333444455556666777788889999', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'company', $1)`,
        [guardianId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    // Distributor kind must have holder_distributor_id and null holder_guardian_user_id
    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind)
         VALUES('33334444555566667777888899990000', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'distributor')`,
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_distributor_id, holder_guardian_user_id)
         VALUES('44445555666677778888999900001111', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'distributor', $1, $2)`,
        [distributorId, guardianId],
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    // Guardian kind must have holder_guardian_user_id and null holder_distributor_id
    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind)
         VALUES('55556666777788889999000011112222', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'guardian')`,
      ),
    ).rejects.toThrow(/tags_holder_fk_consistency/);

    await expect(
      db.query(
        `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_distributor_id, holder_guardian_user_id)
         VALUES('66667777888899990000111122223333', 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'guardian', $1, $2)`,
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
      `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'company')`,
      [companyTag],
    );

    // Guardian stock
    const guardianTag = "22222222333333334444444455555555";
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_guardian_user_id)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'active', 'guardian', $2)`,
      [guardianTag, guardianId],
    );

    // Distributor stock
    const distTag = "33333333444444445555555566666666";
    await db.query(
      `INSERT INTO tags(code, category, category_id, form, status, inventory_status, holder_kind, holder_distributor_id)
       VALUES($1, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'manufactured', 'blank', 'distributor', $2)`,
      [distTag, distributorId],
    );

    // Company admin may act on company tag, not on guardian or distributor tag
    await expect(
      custody.assertMayAct({ id: adminId, role: "company_admin" }, companyTag),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct({ id: adminId, role: "company_admin" }, guardianTag),
    ).rejects.toThrow(/does not permit/);
    await expect(
      custody.assertMayAct({ id: adminId, role: "company_admin" }, distTag),
    ).rejects.toThrow(/does not permit/);

    // Guardian may act on own tag, not on other guardian tag or company tag
    await expect(
      custody.assertMayAct({ id: guardianId, role: "guardian" }, guardianTag),
    ).resolves.toBeUndefined();
    await expect(
      custody.assertMayAct({ id: otherGuardianId, role: "guardian" }, guardianTag),
    ).rejects.toThrow(/does not permit/);
    await expect(
      custody.assertMayAct({ id: guardianId, role: "guardian" }, companyTag),
    ).rejects.toThrow(/does not permit/);

    // Distributor without category permission cannot act
    await expect(
      custody.assertMayAct({ id: distUserId, role: "distributor" }, distTag),
    ).rejects.toThrow(/does not permit/);

    // Distributor with matching category permission can act
    await db.query(
      "INSERT INTO distributor_allowed_categories(distributor_id, category_id) VALUES($1, (SELECT id FROM categories WHERE key = 'medical'))",
      [distributorId],
    );
    await expect(
      custody.assertMayAct({ id: distUserId, role: "distributor" }, distTag),
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
      `INSERT INTO tags(code, ward_id, category, category_id, form, status, inventory_status, holder_distributor_id, assigned_guardian_user_id, holder_kind, holder_guardian_user_id)
       VALUES($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', 'active', NULL, $3, 'guardian', $3)`,
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
      custody.assertMayAct({ id: guardianId, role: "guardian" }, tagItem.code),
    ).resolves.toBeUndefined();
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
});
