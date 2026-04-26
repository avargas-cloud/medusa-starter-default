/**
 * GET  /admin/purchase-orders/qb-pipeline — list qb_purchase_order_pipeline rows
 * POST /admin/purchase-orders/qb-pipeline/:id/retry — re-queue a failed entry
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { status, search } = req.query as Record<string, string | undefined>;

    const conditions: string[] = ["pipe.deleted_at IS NULL"];
    const values: unknown[] = [];
    let p = 1;

    if (status && status !== "__all__") {
      conditions.push(`pipe.status = $${p++}`);
      values.push(status);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const { rows } = await client.query(
      `SELECT
       pipe.id,
       pipe.seq,
       pipe.purchase_order_id,
       po.number      AS po_number,
       po.draft_number,
       pipe.status,
       pipe.qb_operation_id,
       pipe.qb_list_id,
       pipe.qb_txn_number,
       pipe.last_error,
       pipe.retries,
       pipe.next_retry_at,
       pipe.synced_at,
       pipe.created_at,
       pipe.updated_at,
       COALESCE(po.vendor_name_snapshot, po.vendor_id) AS vendor_name,
       CASE
         WHEN (pipe.payload->>'is_void')::boolean = true  THEN 'void_purchase_order'
         WHEN (pipe.payload->>'is_mod')::boolean  = true  THEN 'mod_purchase_order'
         ELSE 'purchase_order'
       END AS step
     FROM qb_purchase_order_pipeline pipe
     LEFT JOIN purchase_order po ON po.id = pipe.purchase_order_id
     ${where}
     ORDER BY pipe.seq DESC
     LIMIT 200`,
      values
    );

    // Filter by search client-side is fine for small datasets; do it in SQL for correctness
    const searchLower = search?.toLowerCase();
    const filtered = searchLower
      ? rows.filter((r) =>
          [
            r.po_number,
            r.draft_number,
            r.vendor_name,
            r.qb_list_id,
            r.last_error,
            r.qb_txn_number,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(searchLower)
        )
      : rows;

    const counts: Record<string, number> = {
      waiting: 0,
      processing: 0,
      synced: 0,
      error: 0,
    };
    for (const r of rows) {
      const s = r.status as string;
      if (s in counts) counts[s] = (counts[s] ?? 0) + 1;
    }

    return res.json({ rows: filtered, counts });
  } finally {
    await client.end();
  }
}
