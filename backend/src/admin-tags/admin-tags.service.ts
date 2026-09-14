import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import * as QRCode from "qrcode";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { DatabaseService } from "../database/database.service";
import { AuthenticatedUser } from "../common/request-user";
import { createActivationPin, createPublicTagCode, normalizeTagCode } from "../domain/tag-code";

const commonJsRequire = createRequire(__filename);
const pointsPerMillimetre = 72 / 25.4;
const sheetQrSize = 25 * pointsPerMillimetre;
const pdfColor = (hex: string) => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
};
@Injectable()
export class AdminTagsService {
  constructor(private readonly db: DatabaseService) {}
  async create(
    actor: AuthenticatedUser,
    input: { categoryKey: string; form: string; quantity: number },
  ) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 500)
      throw new BadRequestException("Quantity must be 1-500");
    return this.db.transaction(async (client) => {
      const category = await client.query<{ id: string }>(
        "SELECT id FROM categories WHERE key=$1 AND status='active'",
        [input.categoryKey],
      );
      if (!category.rows[0]) throw new NotFoundException("Category unavailable");
      const batchCode = `B-${randomBytes(6).toString("hex").toUpperCase()}`;
      const batch = await client.query<{ id: string }>(
        `INSERT INTO tag_batches(batch_code,category_id,form,quantity,created_by_user_id,tenant_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [batchCode, category.rows[0]!.id, input.form, input.quantity, actor.id, actor.tenantId],
      );
      const codes: string[] = [];
      const tags: Array<{ code: string; pin: string }> = [];
      let attempts = 0;
      while (codes.length < input.quantity) {
        if (attempts++ > input.quantity * 10) {
          throw new BadRequestException("Could not allocate unique tag codes");
        }
        const value = createPublicTagCode();
        const pin = createActivationPin();
        const pinHash = await bcrypt.hash(pin, 8);
        const inserted = await client.query(
          `INSERT INTO tags(code,batch_id,category,category_id,form,inventory_status,holder_kind,activation_pin_hash,pin_expires_at,tenant_id)
           VALUES($1,$2,$3,$4,$5,'blank','company',$6,now() + interval '1 year',$7) ON CONFLICT DO NOTHING RETURNING code`,
          [
            value,
            batch.rows[0]!.id,
            input.categoryKey,
            category.rows[0]!.id,
            input.form,
            pinHash,
            actor.tenantId,
          ],
        );
        if (inserted.rowCount) {
          codes.push(value);
          tags.push({ code: value, pin });
        }
      }
      return { id: batch.rows[0]!.id, batchCode, codes, tags };
    });
  }
  private async tag(actor: AuthenticatedUser, tagCode: string) {
    const result = await this.db.query<{ code: string; category: string; color: string }>(
      `SELECT t.code,c.key AS category,c.color FROM tags t JOIN categories c ON c.id=t.category_id WHERE t.code=$1 AND t.tenant_id=$2`,
      [normalizeTagCode(tagCode), actor.tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException("Tag unavailable");
    return result.rows[0];
  }
  async png(actor: AuthenticatedUser, tagCode: string) {
    const tag = await this.tag(actor, tagCode);
    const url = `${process.env.PUBLIC_SCAN_BASE_URL ?? "http://localhost:8080"}/scan?tag=${encodeURIComponent(tag.code)}`;
    const qr = await QRCode.toBuffer(url, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 1000,
      color: { dark: "#111111", light: "#ffffff" },
    });
    // sharp is a CommonJS callable export when this NestJS build executes.
    const sharp = commonJsRequire("sharp") as (input: Buffer) => {
      extend: (options: unknown) => {
        composite: (items: unknown[]) => { png: () => { toBuffer: () => Promise<Buffer> } };
      };
    };
    return sharp(qr)
      .extend({ top: 90, bottom: 150, left: 90, right: 90, background: "#ffffff" })
      .composite([
        {
          input: Buffer.from(
            `<svg width="1180" height="1240"><rect x="20" y="20" width="1140" height="1200" rx="28" fill="none" stroke="${tag.color}" stroke-width="20"/><text x="590" y="70" text-anchor="middle" font-family="Arial" font-size="34" font-weight="bold" fill="${tag.color}">SAFETYSPELL · ${tag.category.toUpperCase()}</text><circle cx="590" cy="590" r="55" fill="white"/><text x="590" y="607" text-anchor="middle" font-family="Arial" font-size="32" font-weight="bold" fill="#111">SS</text><text x="590" y="1135" text-anchor="middle" font-family="monospace" font-size="32" fill="#111">${tag.code}</text><text x="590" y="1182" text-anchor="middle" font-family="Arial" font-size="20" fill="#333">Backup code · scan to open in your browser</text></svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
  }
  async pdf(actor: AuthenticatedUser, batchId: string) {
    const rows = await this.db.query<{ code: string; color: string }>(
      `SELECT t.code, c.color FROM tags t JOIN categories c ON c.id=t.category_id
       WHERE t.batch_id=$1 AND t.tenant_id=$2 ORDER BY t.code`,
      [batchId, actor.tenantId],
    );
    if (!rows.rowCount) throw new NotFoundException("Batch unavailable");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < rows.rows.length; i += 1) {
      // A4 (210 × 297 mm); each QR is fixed at 25 mm before printer scaling.
      if (i % 10 === 0) pdf.addPage([210 * pointsPerMillimetre, 297 * pointsPerMillimetre]);
      const page = pdf.getPages().at(-1)!;
      const x = 35 + (i % 2) * 275,
        y = 790 - Math.floor((i % 10) / 2) * 155;
      const tag = rows.rows[i]!;
      // Sheets intentionally avoid Sharp: the QR stays a plain, near-black raster while
      // the frame/logo are PDF vectors. This prevents serial high-resolution composites.
      const qr = await pdf.embedPng(
        await QRCode.toBuffer(
          `${process.env.PUBLIC_SCAN_BASE_URL ?? "http://localhost:8080"}/scan?tag=${encodeURIComponent(tag.code)}`,
          {
            errorCorrectionLevel: "H",
            margin: 2,
            width: 360,
            color: { dark: "#111111", light: "#ffffff" },
          },
        ),
      );
      page.drawRectangle({
        x: x - 8,
        y: y - sheetQrSize - 24,
        width: sheetQrSize + 16,
        height: sheetQrSize + 44,
        borderWidth: 2,
        borderColor: pdfColor(tag.color),
      });
      page.drawImage(qr, { x, y: y - sheetQrSize, width: sheetQrSize, height: sheetQrSize });
      page.drawCircle({
        x: x + sheetQrSize / 2,
        y: y - sheetQrSize / 2,
        size: 4,
        color: rgb(1, 1, 1),
      });
      page.drawText("SS", {
        x: x + sheetQrSize / 2 - 3,
        y: y - sheetQrSize / 2 - 2,
        size: 4,
        font,
        color: rgb(0.07, 0.07, 0.07),
      });
      page.drawText(tag.code, {
        x,
        y: y - sheetQrSize - 15,
        size: 7,
        font,
        color: rgb(0, 0, 0),
      });
    }
    return Buffer.from(await pdf.save());
  }
}
