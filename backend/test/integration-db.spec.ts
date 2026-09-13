import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import * as request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApi } from "../src/bootstrap";

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
  "guidance_rule_versions",
  "guidance_rules",
  "privacy_notices",
  "consent_audit",
  "ward_field_visibility",
  "ward_field_values",
  "tags",
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
    `INSERT INTO tags(code, ward_id, category, category_id, form, status, activated_at)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', now())`,
    [tagCode, wardId],
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
    `INSERT INTO tags(code, ward_id, category, category_id, form, status, activated_at)
     VALUES ($1, $2, 'medical', (SELECT id FROM categories WHERE key = 'medical'), 'band', 'active', now())`,
    [tagCode, wardId],
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
});
