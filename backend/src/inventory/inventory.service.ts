import { ForbiddenException, Injectable } from "@nestjs/common";
import { AuthenticatedUser } from "../common/request-user";
import { DatabaseService } from "../database/database.service";

export interface InventoryQuery {
  status?: "blank" | "assigned" | "active" | "lost" | "revoked";
  categoryKey?: string;
  distributorId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface InventoryCounts {
  blank: number;
  assigned: number;
  active: number;
  lost: number;
  revoked: number;
  total: number;
}

export interface InventoryItem {
  id: string;
  code: string;
  category: string;
  form: string;
  status: "blank" | "assigned" | "active" | "lost" | "revoked";
  holderKind: "company" | "distributor" | "guardian";
  distributorName?: string | null;
  sourceDistributorName?: string | null;
  assignedReference: string | null;
  createdAt: string;
  assignedAt: string | null;
  activatedAt: string | null;
  statusChangedAt: string | null;
}

export interface InventoryResult {
  items: InventoryItem[];
  total: number;
  page: number;
  limit: number;
  counts: InventoryCounts;
}

@Injectable()
export class InventoryService {
  constructor(private readonly db: DatabaseService) {}

  async listInventory(actor: AuthenticatedUser, query: InventoryQuery): Promise<InventoryResult> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = (page - 1) * limit;

    let distributorId: string | null = null;
    if (actor.role === "distributor") {
      const userRes = await this.db.query<{ distributor_id: string | null }>(
        "SELECT distributor_id FROM users WHERE id = $1 AND tenant_id = $2",
        [actor.id, actor.tenantId],
      );
      distributorId = userRes.rows[0]?.distributor_id ?? null;
      if (!distributorId) {
        throw new ForbiddenException("User is not associated with a distributor entity");
      }
    }

    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    whereClauses.push(`t.tenant_id = $${paramIdx}`);
    params.push(actor.tenantId);
    paramIdx++;

    // Role-scoped base filter
    if (actor.role === "distributor") {
      whereClauses.push(
        `(t.holder_distributor_id = $${paramIdx} OR t.source_distributor_id = $${paramIdx})`,
      );
      params.push(distributorId);
      paramIdx++;
    } else if (actor.role === "company_admin" && query.distributorId) {
      whereClauses.push(
        `(t.holder_distributor_id = $${paramIdx} OR t.source_distributor_id = $${paramIdx})`,
      );
      params.push(query.distributorId);
      paramIdx++;
    }

    // Status filter
    if (query.status) {
      whereClauses.push(`t.inventory_status = $${paramIdx}`);
      params.push(query.status);
      paramIdx++;
    }

    // Category filter
    if (query.categoryKey) {
      whereClauses.push(`t.category = $${paramIdx}`);
      params.push(query.categoryKey);
      paramIdx++;
    }

    // Code search
    if (query.search?.trim()) {
      whereClauses.push(`upper(t.code) LIKE upper($${paramIdx})`);
      params.push(`%${query.search.trim()}%`);
      paramIdx++;
    }

    // Date range filters (against status_changed_at or created_at)
    if (query.fromDate) {
      whereClauses.push(`COALESCE(t.status_changed_at, t.created_at) >= $${paramIdx}`);
      params.push(new Date(query.fromDate));
      paramIdx++;
    }
    if (query.toDate) {
      whereClauses.push(`COALESCE(t.status_changed_at, t.created_at) <= $${paramIdx}`);
      params.push(new Date(query.toDate));
      paramIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // 1. Calculate Count Strip (counts for all 5 explicit statuses in the role-scoped inventory)
    const countScopeClauses: string[] = [];
    const countScopeParams: unknown[] = [];
    let countParamIdx = 1;

    countScopeClauses.push(`t.tenant_id = $${countParamIdx}`);
    countScopeParams.push(actor.tenantId);
    countParamIdx++;

    if (actor.role === "distributor") {
      countScopeClauses.push(
        `(t.holder_distributor_id = $${countParamIdx} OR t.source_distributor_id = $${countParamIdx})`,
      );
      countScopeParams.push(distributorId);
      countParamIdx++;
    } else if (actor.role === "company_admin" && query.distributorId) {
      countScopeClauses.push(
        `(t.holder_distributor_id = $${countParamIdx} OR t.source_distributor_id = $${countParamIdx})`,
      );
      countScopeParams.push(query.distributorId);
      countParamIdx++;
    }
    if (query.categoryKey) {
      countScopeClauses.push(`t.category = $${countParamIdx}`);
      countScopeParams.push(query.categoryKey);
      countParamIdx++;
    }

    const countScopeSql =
      countScopeClauses.length > 0 ? `WHERE ${countScopeClauses.join(" AND ")}` : "";

    const countsQuery = `
      SELECT t.inventory_status, count(*)::int as count
      FROM tags t
      ${countScopeSql}
      GROUP BY t.inventory_status
    `;
    const countsRes = await this.db.query<{ inventory_status: string; count: number }>(
      countsQuery,
      countScopeParams,
    );

    const counts: InventoryCounts = {
      blank: 0,
      assigned: 0,
      active: 0,
      lost: 0,
      revoked: 0,
      total: 0,
    };
    for (const row of countsRes.rows) {
      const statusKey = row.inventory_status as keyof Omit<InventoryCounts, "total">;
      if (statusKey in counts) {
        counts[statusKey] = row.count;
        counts.total += row.count;
      }
    }

    // 2. Count matching filtered rows
    const totalCountRes = await this.db.query<{ count: string }>(
      `SELECT count(*)::text as count FROM tags t ${whereSql}`,
      params,
    );
    const total = parseInt(totalCountRes.rows[0]?.count ?? "0", 10);

    // 3. Query paginated items
    const itemsQuery = `
      SELECT t.id, t.code, t.category, t.form, t.inventory_status, t.holder_kind,
             t.assignment_reference, t.ward_id,
             t.created_at, t.assigned_at, t.activated_at, t.status_changed_at,
             d.name as holder_distributor_name,
             sd.name as source_distributor_name
      FROM tags t
      LEFT JOIN distributors d ON d.id = t.holder_distributor_id
      LEFT JOIN distributors sd ON sd.id = t.source_distributor_id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;

    const itemsParams = [...params, limit, offset];
    const itemsRes = await this.db.query<{
      id: string;
      code: string;
      category: string;
      form: string;
      inventory_status: string;
      holder_kind: string;
      assignment_reference: string | null;
      ward_id: string | null;
      created_at: Date;
      assigned_at: Date | null;
      activated_at: Date | null;
      status_changed_at: Date | null;
      holder_distributor_name: string | null;
      source_distributor_name: string | null;
    }>(itemsQuery, itemsParams);

    const items: InventoryItem[] = itemsRes.rows.map((row) => {
      let assignedReference: string | null = null;
      if (row.inventory_status === "assigned" || row.inventory_status === "active") {
        if (actor.role === "company_admin") {
          assignedReference =
            row.assignment_reference ?? (row.ward_id ? `WARD-${row.ward_id.slice(0, 8)}` : null);
        } else {
          // Distributor sees masked reference only, never raw ward ID or guardian details
          assignedReference = row.ward_id ? `REF-***-${row.ward_id.slice(-4)}` : "REF-***-ASGD";
        }
      }

      return {
        id: row.id,
        code: row.code,
        category: row.category,
        form: row.form,
        status: row.inventory_status as InventoryItem["status"],
        holderKind: row.holder_kind as InventoryItem["holderKind"],
        distributorName:
          actor.role === "company_admin" ? (row.holder_distributor_name ?? null) : undefined,
        sourceDistributorName:
          actor.role === "company_admin" ? (row.source_distributor_name ?? null) : undefined,
        assignedReference,
        createdAt: row.created_at.toISOString(),
        assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
        activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
        statusChangedAt: row.status_changed_at ? row.status_changed_at.toISOString() : null,
      };
    });

    return {
      items,
      total,
      page,
      limit,
      counts,
    };
  }
}
