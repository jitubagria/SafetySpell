import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createPublicTagCode } from "../src/domain/tag-code";

describe("Phase 6 Slice 2: Database Role Hardening & Append-Only Privilege Enforcement", () => {
  const adminDbUrl =
    process.env.INTEGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/safetyspell_integration";

  // Build app role connection string by replacing user and password with safetyspell_app credentials
  const appDbUrl = adminDbUrl.replace(
    /postgres:\/\/[^@]+@/,
    "postgres://safetyspell_app:safetyspell_app_password@",
  );

  let adminPool: Pool;
  let appPool: Pool;
  let testTagId: string;
  let testTagCode: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminDbUrl });
    appPool = new Pool({ connectionString: appDbUrl });

    // Seed a test tag via admin pool
    testTagCode = createPublicTagCode();
    const tagRes = await adminPool.query(
      `INSERT INTO tags (
        code, category, category_id, form, inventory_status, holder_kind,
        activation_pin_hash, pin_failed_attempts, activated_at
      ) VALUES ($1, 'elderly', (SELECT id FROM categories WHERE key = 'elderly' LIMIT 1), 'band', 'active', 'company', NULL, 0, NOW())
      RETURNING id`,
      [testTagCode],
    );
    testTagId = tagRes.rows[0].id;
  });

  afterAll(async () => {
    await appPool.end();
    await adminPool.end();
  });

  describe("1. tag_events append-only privilege enforcement (safetyspell_app)", () => {
    it("allows safetyspell_app to INSERT and SELECT tag_events", async () => {
      const eventRes = await appPool.query(
        `INSERT INTO tag_events (tag_id, event_type, from_status, to_status, metadata)
         VALUES ($1, 'assigned', 'blank', 'assigned', '{"test": true}'::jsonb)
         RETURNING id, event_type`,
        [testTagId],
      );
      expect(eventRes.rows[0].event_type).toBe("assigned");

      const selectRes = await appPool.query(`SELECT * FROM tag_events WHERE id = $1`, [
        eventRes.rows[0].id,
      ]);
      expect(selectRes.rows).toHaveLength(1);
    });

    it("strictly rejects raw UPDATE on tag_events with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(
        appPool.query(
          `UPDATE tag_events SET metadata = '{"tampered": true}'::jsonb WHERE tag_id = $1`,
          [testTagId],
        ),
      ).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
        message: expect.stringMatching(/permission denied for table tag_events/i),
      });
    });

    it("strictly rejects raw DELETE on tag_events with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(
        appPool.query(`DELETE FROM tag_events WHERE tag_id = $1`, [testTagId]),
      ).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
        message: expect.stringMatching(/permission denied for table tag_events/i),
      });
    });

    it("strictly rejects TRUNCATE on tag_events with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(appPool.query(`TRUNCATE tag_events`)).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
        message: expect.stringMatching(/permission denied for table tag_events/i),
      });
    });
  });

  describe("2. consent_audit append-only privilege enforcement (safetyspell_app)", () => {
    let wardId: string;
    let guardianId: string;

    beforeAll(async () => {
      guardianId = randomUUID();
      wardId = randomUUID();
      await adminPool.query(
        `INSERT INTO users (id, name, email, password_hash, role)
         VALUES ($1, 'Role Test Guardian', $2, 'hash', 'guardian')`,
        [guardianId, `${guardianId}@example.test`],
      );
      await adminPool.query(
        `INSERT INTO wards (id, category, name) VALUES ($1, 'elderly', 'Role Test Ward')`,
        [wardId],
      );
    });

    it("allows safetyspell_app to INSERT and SELECT consent_audit", async () => {
      const auditRes = await appPool.query(
        `INSERT INTO consent_audit (ward_id, event_type, new_visibility, changed_by)
         VALUES ($1, 'visibility_changed', 'public', $2)
         RETURNING id, event_type`,
        [wardId, guardianId],
      );
      expect(auditRes.rows[0].event_type).toBe("visibility_changed");

      const selectRes = await appPool.query(`SELECT * FROM consent_audit WHERE id = $1`, [
        auditRes.rows[0].id,
      ]);
      expect(selectRes.rows).toHaveLength(1);
    });

    it("strictly rejects raw UPDATE on consent_audit with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(
        appPool.query(
          `UPDATE consent_audit SET session_metadata = '{"tampered": true}'::jsonb WHERE ward_id = $1`,
          [wardId],
        ),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied for table consent_audit/i),
      });
    });

    it("strictly rejects raw DELETE on consent_audit with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(
        appPool.query(`DELETE FROM consent_audit WHERE ward_id = $1`, [wardId]),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied for table consent_audit/i),
      });
    });

    it("strictly rejects TRUNCATE on consent_audit with PostgreSQL 42501 (insufficient_privilege)", async () => {
      await expect(appPool.query(`TRUNCATE consent_audit`)).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied for table consent_audit/i),
      });
    });
  });

  describe("3. scan_log append-only enforcement", () => {
    let scanLogId: string;

    it("allows safetyspell_app to INSERT and SELECT scan_log", async () => {
      const logRes = await appPool.query(
        `INSERT INTO scan_log (tag_id, policy_version, shown_field_keys)
         VALUES ($1, 1, '["blood_group"]'::jsonb)
         RETURNING id`,
        [testTagId],
      );
      scanLogId = logRes.rows[0].id;

      const selectRes = await appPool.query(`SELECT * FROM scan_log WHERE id = $1`, [scanLogId]);
      expect(selectRes.rows).toHaveLength(1);
    });

    it("rejects owner UPDATE and DELETE through append-only triggers", async () => {
      await expect(
        adminPool.query(`UPDATE scan_log SET policy_version = 2 WHERE id = $1`, [scanLogId]),
      ).rejects.toThrow(/scan_log is append-only/);
      await expect(
        adminPool.query(`DELETE FROM scan_log WHERE id = $1`, [scanLogId]),
      ).rejects.toThrow(/scan_log is append-only/);
    });

    it("rejects runtime-role UPDATE, DELETE, and TRUNCATE with PostgreSQL 42501", async () => {
      await expect(
        appPool.query(`UPDATE scan_log SET policy_version = 2 WHERE id = $1`, [scanLogId]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        appPool.query(`DELETE FROM scan_log WHERE id = $1`, [scanLogId]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(appPool.query("TRUNCATE scan_log")).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("4. Core entity table immutability (safetyspell_app)", () => {
    it("strictly rejects TRUNCATE and DELETE on tags table with PostgreSQL 42501", async () => {
      await expect(
        appPool.query(`DELETE FROM tags WHERE id = $1`, [testTagId]),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied for table tags/i),
      });

      await expect(appPool.query(`TRUNCATE tags CASCADE`)).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied for table tags/i),
      });
    });

    it("allows legitimate application operations (SELECT, UPDATE on operational columns) as safetyspell_app", async () => {
      const updateRes = await appPool.query(
        `UPDATE tags SET status_changed_at = NOW() WHERE id = $1 RETURNING id, status_changed_at`,
        [testTagId],
      );
      expect(updateRes.rows).toHaveLength(1);
    });
  });
});
