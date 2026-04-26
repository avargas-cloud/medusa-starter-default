/**
 * POST /admin/purchase-orders/qb-pipeline/:id/mark-fixed
 * Acknowledges a failed/errored PO pipeline entry as manually resolved in QB Desktop.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };
  const knex = (req.scope as any).resolve("__pg_connection__");

  const rows = await knex
    .raw(
      `SELECT id, status FROM qb_purchase_order_pipeline WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id]
    )
    .then((r: any) => r.rows);

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Pipeline entry not found" });

  await knex.raw(
    `UPDATE qb_purchase_order_pipeline
        SET status = 'synced',
            last_error = NULL,
            next_retry_at = NULL,
            synced_at = NOW(),
            updated_at = NOW()
      WHERE id = ?`,
    [id]
  );

  return res.json({ success: true, message: "Marked as fixed" });
}
