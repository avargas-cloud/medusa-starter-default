/**
 * src/api/admin/qb-catalog/inventory-adjustment-pipeline/route.ts
 *
 * GET /admin/qb-catalog/inventory-adjustment-pipeline
 *
 * UNIONs both pipeline tables so the Inventory Adjustments tab shows all rows:
 *   - qb_inventory_adjustment_pipeline  (legacy rows, status already in UI vocab)
 *   - qb_order_pipeline WHERE step = 'inventory_adjustment'  (new unified rows)
 *
 * Status mapping for new table rows:
 *   pending → waiting | submitted → processing | confirmed → synced | failed → error
 *
 * void_status for new rows comes from a sibling void_inventory_adjustment row.
 */

import { getDbPool } from "../../../../api/utils/db-pool";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type UiAddStatus = "waiting" | "processing" | "synced" | "error";
type UiVoidStatus = "waiting" | "processing" | "voided" | "error" | null;

const toIso = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

const ALLOWED_UI_STATUSES = new Set(["waiting", "processing", "synced", "error"]);

const UI_TO_DB_STATUS: Record<string, string> = {
  waiting: "pending",
  processing: "submitted",
  synced: "confirmed",
  error: "failed",
};

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const pool = getDbPool();

  const limitParam = Number(req.query.limit ?? 50);
  const offsetParam = Number(req.query.offset ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(200, Math.max(1, limitParam)) : 50;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

  const uiStatus = req.query.status ? String(req.query.status) : "";
  const hasStatusFilter = ALLOWED_UI_STATUSES.has(uiStatus);

  // ── Legacy table (status already in UI vocab) ─────────────────────────────
  const legacyStatusClause = hasStatusFilter ? `AND old.status = '${uiStatus}'` : "";

  // ── New table (status needs mapping) ─────────────────────────────────────
  const newDbStatus = hasStatusFilter ? UI_TO_DB_STATUS[uiStatus] : null;
  const newStatusClause = newDbStatus ? `AND ia.status = '${newDbStatus}'` : "";

  const unionSql = `
    -- ── Legacy rows from qb_inventory_adjustment_pipeline ──
    SELECT
      old.id,
      old.seq,
      old.inventory_count_id        AS count_id,
      NULL::text                    AS count_number_col,
      old.payload,
      old.status                    AS ui_status,
      old.void_status               AS ui_void_status,
      old.qb_txn_number,
      old.last_error,
      old.void_last_error,
      old.retries,
      old.void_retries,
      old.synced_at,
      old.void_synced_at,
      old.created_at,
      old.updated_at,
      old.qb_account_list_id        AS payload_account_override
    FROM qb_inventory_adjustment_pipeline old
    WHERE old.deleted_at IS NULL
    ${legacyStatusClause}

    UNION ALL

    -- ── New rows from qb_order_pipeline ──
    SELECT
      ia.id::text,
      ia.seq,
      ia.order_id                   AS count_id,
      ia.medusa_ref_number          AS count_number_col,
      ia.payload,
      CASE ia.status
        WHEN 'pending'   THEN 'waiting'
        WHEN 'submitted' THEN 'processing'
        WHEN 'confirmed' THEN 'synced'
        WHEN 'failed'    THEN 'error'
        ELSE ia.status
      END                           AS ui_status,
      CASE via.status
        WHEN 'pending'   THEN 'waiting'
        WHEN 'submitted' THEN 'processing'
        WHEN 'confirmed' THEN 'voided'
        WHEN 'failed'    THEN 'error'
        ELSE NULL
      END                           AS ui_void_status,
      ia.qb_ref_number              AS qb_txn_number,
      ia.error                      AS last_error,
      via.error                     AS void_last_error,
      ia.retry_count                AS retries,
      COALESCE(via.retry_count, 0)  AS void_retries,
      ia.confirmed_at               AS synced_at,
      via.confirmed_at              AS void_synced_at,
      ia.created_at,
      ia.updated_at,
      NULL::text                    AS payload_account_override
    FROM qb_order_pipeline ia
    LEFT JOIN qb_order_pipeline via
           ON via.reference_id = ia.reference_id
          AND via.step = 'void_inventory_adjustment'
    WHERE ia.step = 'inventory_adjustment'
    ${newStatusClause}
  `;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM (${unionSql}) combined ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(`SELECT COUNT(*) AS total FROM (${unionSql}) combined`, []),
  ]);

  const enriched = dataResult.rows.map((r) => {
    const payload = (r.payload ?? {}) as {
      count_number?: string;
      count_memo?: string;
      qb_account_list_id?: string;
      lines?: Array<{ delta_applied?: number }>;
    };
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const totalDeltaUnits = lines.reduce(
      (acc, l) => acc + Math.abs(Number(l.delta_applied ?? 0)),
      0
    );

    return {
      id: r.id as string,
      seq: r.seq as number,
      status: (r.ui_status ?? "waiting") as UiAddStatus,
      void_status: (r.ui_void_status ?? null) as UiVoidStatus,
      count_id: (r.count_id as string) ?? null,
      count_number: (r.count_number_col as string | null) ?? payload.count_number ?? null,
      count_memo: payload.count_memo ?? null,
      qb_account_list_id: (r.payload_account_override as string | null) ?? payload.qb_account_list_id ?? null,
      qb_txn_number: (r.qb_txn_number as string | null) ?? null,
      qb_list_id: null,
      retries: (r.retries as number) ?? 0,
      void_retries: (r.void_retries as number) ?? 0,
      last_error: (r.last_error as string | null) ?? null,
      void_last_error: (r.void_last_error as string | null) ?? null,
      synced_at: toIso(r.synced_at),
      void_synced_at: toIso(r.void_synced_at),
      lines_count: lines.length,
      total_delta_units: totalDeltaUnits,
      created_at: toIso(r.created_at) ?? "",
      updated_at: toIso(r.updated_at) ?? "",
    };
  });

  return res.json({
    rows: enriched,
    count: Number((countResult.rows[0] as { total: string }).total),
  });
};
