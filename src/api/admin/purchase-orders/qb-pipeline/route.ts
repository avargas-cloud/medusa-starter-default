/**
 * GET /admin/purchase-orders/qb-pipeline
 *
 * Returns a unified feed of QuickBooks Purchase-side pipeline operations:
 *   - qb_purchase_order_pipeline rows  → PO add / mod / void
 *   - qb_item_receipt_pipeline rows    → ItemReceipt add  (always one row)
 *                                        ItemReceipt mod (extra row emitted
 *                                        when mod_status IS NOT NULL — editing
 *                                        an already-synced receipt)
 *                                        ItemReceipt delete (extra row
 *                                        emitted when void_status IS NOT NULL;
 *                                        ItemReceipts only support hard delete
 *                                        in QB Desktop — there is no void).
 *   - qb_vendor_bill_pipeline rows      → Vendor Bill add / delete
 *   - qb_order_pipeline rows            → append-only Vendor Bill mod history
 *
 * The frontend renders both kinds in the same table. To keep React keys
 * unique, mod rows for ItemReceipts use the composite id `<pipeline_id>__mod`
 * and void/delete rows use `<pipeline_id>__void`. Retry / mark-fixed routes
 * parse these suffixes to decide which table + columns to update.
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
          pipe.seq::text                                 AS seq_label,
          pipe.purchase_order_id                         AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
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
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
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

        -- ── ItemReceipt MOD pipeline (only when mod_status is set) ───────
        SELECT
          qbp.id || '__mod'                              AS id,
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
          qbp.mod_status                                 AS status,
          qbp.mod_operation_id                           AS qb_operation_id,
          qbp.qb_list_id                                 AS qb_list_id,
          NULL::text                                     AS qb_txn_number,
          qbp.mod_last_error                             AS last_error,
          COALESCE(qbp.mod_retries, 0)                   AS retries,
          qbp.mod_next_retry_at                          AS next_retry_at,
          qbp.mod_synced_at                               AS synced_at,
          qbp.created_at                                 AS created_at,
          qbp.updated_at                                 AS updated_at,
          COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
          'mod_item_receipt'                             AS step
        FROM qb_item_receipt_pipeline qbp
        LEFT JOIN purchase_order_receipt por ON por.id = qbp.purchase_order_receipt_id
        LEFT JOIN purchase_order po ON po.id = qbp.purchase_order_id
        WHERE qbp.deleted_at IS NULL
          AND qbp.mod_status IS NOT NULL

        UNION ALL

        -- ── ItemReceipt VOID/DELETE pipeline (only when void_status is set)
        SELECT
          qbp.id || '__void'                             AS id,
          qbp.seq                                        AS seq,
          ('R' || qbp.seq::text)                         AS seq_label,
          qbp.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          NULL::text                                     AS draft_number,
          por.number                                     AS receipt_number,
          NULL::text                                     AS vendor_bill_number,
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

        UNION ALL

        -- ── Vendor Bill ADD pipeline ─────────────────────────────────────
        -- MOD reuses the operational qvb row. Once a QB TxnID exists, keep
        -- representing the original ADD as terminal history while MOD history
        -- comes from its append-only qb_order_pipeline rows below.
        SELECT
          qvb.id || '__vendor_bill_add'                  AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qvb.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE
            WHEN qvb.qb_txn_id IS NOT NULL THEN 'synced'
            WHEN qvb.intent = 'add' THEN qvb.status
            ELSE qvb.status
          END                                            AS status,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.qb_operation_id
          END
                                                           AS qb_operation_id,
          qvb.qb_txn_id                                  AS qb_list_id,
          COALESCE(qvb.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.last_error
          END
                                                           AS last_error,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.retries
            ELSE 0
          END
                                                           AS retries,
          CASE
            WHEN qvb.qb_txn_id IS NULL AND qvb.intent = 'add'
              THEN qvb.next_retry_at
          END
                                                           AS next_retry_at,
          COALESCE(qvb.synced_at, vb.qb_synced_at)       AS synced_at,
          COALESCE(vb.confirmed_at, qvb.created_at)      AS created_at,
          qvb.updated_at                                 AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'add_vendor_bill'                              AS step
        FROM qb_vendor_bill_pipeline qvb
        JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qvb.purchase_order_id
        WHERE qvb.deleted_at IS NULL
          AND (qvb.intent = 'add' OR qvb.qb_txn_id IS NOT NULL)

        UNION ALL

        -- ── Vendor Bill MOD history ──────────────────────────────────────
        SELECT
          qop.id::text || '__vendor_bill_mod'            AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qop.order_id                                   AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE
            WHEN qop.status IN ('confirmed','fixed','skipped') THEN 'synced'
            WHEN qop.status = 'failed' AND qop.next_retry_at IS NULL THEN 'failed_permanent'
            WHEN qop.status = 'failed' THEN 'error'
            WHEN qop.status IN ('submitted','processing') THEN 'submitted'
            ELSE 'waiting'
          END                                            AS status,
          qop.bridge_op_id                               AS qb_operation_id,
          COALESCE(qop.qb_txn_id, vb.qb_txn_id)          AS qb_list_id,
          COALESCE(qop.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          qop.error                                      AS last_error,
          COALESCE(qop.retry_count, 0)                   AS retries,
          qop.next_retry_at                              AS next_retry_at,
          qop.confirmed_at                               AS synced_at,
          qop.created_at                                 AS created_at,
          COALESCE(qop.updated_at, qop.confirmed_at, qop.failed_at, qop.submitted_at, qop.created_at)
                                                           AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'mod_vendor_bill'                              AS step
        FROM qb_order_pipeline qop
        JOIN vendor_bill vb ON vb.id = qop.reference_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qop.order_id
        WHERE qop.step = 'vendor_bill_mod'

        UNION ALL

        -- ── Vendor Bill DELETE pipeline ──────────────────────────────────
        SELECT
          qvb.id || '__vendor_bill_delete'               AS id,
          NULL::bigint                                   AS seq,
          ('B' || COALESCE(regexp_replace(vb.number, '\\D', '', 'g'), '?'))
                                                           AS seq_label,
          qvb.purchase_order_id                          AS parent_id,
          po.number                                      AS po_number,
          po.draft_number                                AS draft_number,
          NULL::text                                     AS receipt_number,
          vb.number                                      AS vendor_bill_number,
          CASE WHEN qvb.void_status = 'completed' THEN 'synced'
               ELSE qvb.void_status END                  AS status,
          qvb.void_operation_id                          AS qb_operation_id,
          qvb.qb_txn_id                                  AS qb_list_id,
          COALESCE(qvb.qb_ref_number, vb.reference_id)   AS qb_txn_number,
          qvb.void_last_error                            AS last_error,
          COALESCE(qvb.void_retries, 0)                  AS retries,
          qvb.void_next_retry_at                         AS next_retry_at,
          CASE WHEN qvb.void_status IN ('synced','completed') THEN qvb.updated_at END
                                                           AS synced_at,
          qvb.created_at                                 AS created_at,
          qvb.updated_at                                 AS updated_at,
          COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot, po.vendor_id)
                                                           AS vendor_name,
          'delete_vendor_bill'                           AS step
        FROM qb_vendor_bill_pipeline qvb
        JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
        LEFT JOIN purchase_order po ON po.id = qvb.purchase_order_id
        WHERE qvb.deleted_at IS NULL
          AND qvb.void_status IS NOT NULL
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
        OR COALESCE(vendor_bill_number, '') ILIKE $${p}
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
        `SELECT scoped.*
           FROM (${feedSql}) scoped
           ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        [...values, limit, offset]
      ),
      client.query(
        `SELECT COUNT(*) AS count FROM (${feedSql}) scoped ${where}`,
        values
      ),
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
      completed: 0, // ItemReceipt MOD lane's terminal success value (distinct from 'synced')
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
