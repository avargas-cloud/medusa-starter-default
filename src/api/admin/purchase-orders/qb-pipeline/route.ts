/**
 * GET /admin/purchase-orders/qb-pipeline
 *
 * Returns a unified feed of QuickBooks Purchase-side pipeline operations:
 *   - qb_purchase_order_pipeline rows  → PO add / mod / void
 *   - qb_item_receipt_pipeline rows    → ItemReceipt add  (always one row)
 *                                        ItemReceipt delete (extra row
 *                                        emitted when void_status IS NOT NULL;
 *                                        ItemReceipts only support hard delete
 *                                        in QB Desktop — there is no void).
 *
 * The frontend renders both kinds in the same table. To keep React keys
 * unique, void/delete rows for ItemReceipts use the composite id
 * `<pipeline_id>__void`. Retry / mark-fixed routes parse this suffix to
 * decide which table + columns to update.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { status, search } = req.query as Record<string, string | undefined>;
    const limitParam = Number(req.query.limit ?? 50);
    const offsetParam = Number(req.query.offset ?? 0);
    const limit = Number.isFinite(limitParam)
      ? Math.min(200, Math.max(1, limitParam))
      : 50;
    const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

    const feedSql = `
      SELECT * FROM (
        -- ── Purchase Order pipeline ──────────────────────────────────────
        SELECT
          pipe.id                                        AS id,
          pipe.seq                                       AS seq,
          pipe.purchase_order_id                         AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          pipe.status                                    AS status,
          pipe.qb_operation_id                           AS qb_operation_id,
          pipe.qb_list_id                                AS qb_list_id,
          pipe.qb_txn_number                             AS qb_txn_number,
          pipe.last_error                                AS last_error,
          pipe.retries                                   AS retries,
          pipe.next_retry_at                             AS next_retry_at,
          pipe.synced_at                                 AS synced_at,
          pipe.created_at                                AS created_at,
          pipe.updated_at                                AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          CASE
            WHEN (pipe.payload->>'is_void')::boolean = true THEN 'void_purchase_order'
            WHEN (pipe.payload->>'is_mod')::boolean  = true THEN 'mod_purchase_order'
            ELSE 'purchase_order'
          END                                            AS step
        FROM qb_purchase_order_pipeline pipe
        LEFT JOIN purchase_order po ON po.id = pipe.purchase_order_id
        WHERE pipe.deleted_at IS NULL

        UNION ALL

        -- ── ItemReceipt ADD pipeline (always emit one row) ───────────────
        SELECT
          qbp.id                                         AS id,
          NULL::int                                      AS seq,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          qbp.status                                     AS status,
          qbp.qb_operation_id                            AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.last_error                                 AS last_error,
          qbp.retries                                    AS retries,
          qbp.next_retry_at                              AS next_retry_at,
          qbp.synced_at                                  AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'add_item_receipt'                             AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL

        UNION ALL

        -- ── ItemReceipt VOID/DELETE pipeline (only when void_status is set)
        SELECT
          qbp.id || '__void'                             AS id,
          NULL::int                                      AS seq,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          qbp.void_status                                AS status,
          qbp.void_operation_id                          AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.void_last_error                            AS last_error,
          COALESCE(qbp.void_retries, 0)                  AS retries,
          qbp.void_next_retry_at                         AS next_retry_at,
          qbp.void_synced_at                             AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'delete_item_receipt'                          AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL
          AND qbp.void_status IS NOT NULL
      ) feed
    `;

    const values: unknown[] = [];
    const conditions: string[] = [];
    let p = 1;
    if (status && status !== "__all__") {
      conditions.push(`status = $${p++}`);
      values.push(status);
    }
    if (search) {
      conditions.push(`(
        COALESCE(po_number, '') ILIKE $${p}
        OR COALESCE(draft_number, '') ILIKE $${p}
        OR COALESCE(receipt_number, '') ILIKE $${p}
        OR COALESCE(vendor_name, '') ILIKE $${p}
        OR COALESCE(qb_list_id, '') ILIKE $${p}
        OR COALESCE(last_error, '') ILIKE $${p}
        OR COALESCE(qb_txn_number, '') ILIKE $${p}
      )`);
      values.push(`%${search}%`);
      p++;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [{ rows }, countResult, summaryResult] = await Promise.all([
      client.query(
        `SELECT numbered.*
           FROM (
             SELECT scoped.*,
                    ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS display_seq
             FROM (${feedSql}) scoped
             ${where}
           ) numbered
          ORDER BY created_at DESC, id DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        [...values, limit, offset]
      ),
      client.query(`SELECT COUNT(*) AS count FROM (${feedSql}) scoped ${where}`, values),
      client.query(
        `SELECT status, COUNT(*) AS count FROM (${feedSql}) scoped GROUP BY status`,
        []
      ),
    ]);

    const counts: Record<string, number> = {
      waiting: 0,
      submitted: 0,
      processing: 0,
      synced: 0,
      error: 0,
      failed_permanent: 0,
    };
    for (const r of summaryResult.rows) {
      const s = r.status as string;
      if (s in counts) counts[s] = Number(r.count ?? 0);
    }

    const total = Number(countResult.rows[0]?.count ?? 0);

    return res.json({
      rows,
      counts,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
    });
  } finally {
    await client.end();
  }
}
