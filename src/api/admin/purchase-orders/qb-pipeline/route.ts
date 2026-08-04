/**
 * GET /admin/purchase-orders/qb-pipeline
 *
 * Returns a unified feed of QuickBooks Purchase-side pipeline operations:
 *   - qb_purchase_order_pipeline rows  → PO add / void
 *   - qb_item_receipt_pipeline rows    → ItemReceipt add  (always one row)
 *                                        ItemReceipt delete (extra row
 *                                        emitted when void_status IS NOT NULL;
 *                                        ItemReceipts only support hard delete
 *                                        in QB Desktop — there is no void).
 *   - qb_vendor_bill_pipeline rows      → Vendor Bill add / delete
 *   - qb_order_pipeline rows            → append-only history for every MOD:
 *                                        PO mod, ItemReceipt mod, Vendor Bill
 *                                        mod, and reviewed rebuild
 *                                        preflight/delete
 *
 * The query itself — and why each MOD is its own row — lives in
 * `_lib/feed-sql.ts`, shared with the verifier that audits it.
 *
 * The frontend renders every kind in the same table. To keep React keys unique,
 * composite ids carry a suffix naming their lane (`<pipeline_id>__mod`,
 * `__void`, `<qb_order_pipeline_id>__purchase_order_mod`, …). Retry /
 * mark-fixed routes parse these suffixes to decide which table + columns to
 * update.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import { PURCHASE_PIPELINE_FEED_SQL } from "./_lib/feed-sql";

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

    const feedSql = PURCHASE_PIPELINE_FEED_SQL;

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
      // Terminal, NOT success: the operation was abandoned (usually because its
      // dependency was). Folding it into 'synced' claimed QuickBooks got a
      // change it never got; folding it into 'failed' would light a red badge
      // no retry can clear, which is how badges get ignored.
      skipped: 0,
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
