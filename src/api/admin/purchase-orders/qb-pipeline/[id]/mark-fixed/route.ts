/**
 * POST /admin/purchase-orders/qb-pipeline/:id/mark-fixed
 *
 * Acknowledges a failed/errored pipeline entry as manually resolved in QB
 * Desktop. Branches on id prefix:
 *   - qbpopipe_<ulid>           → qb_purchase_order_pipeline
 *   - qbrcpipe_<ulid>           → qb_item_receipt_pipeline ADD lane
 *   - qbrcpipe_<ulid>__mod      → qb_item_receipt_pipeline MOD lane
 *   - qbrcpipe_<ulid>__void     → qb_item_receipt_pipeline VOID/DELETE lane
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: rawId } = req.params as { id: string };
  const knex = (req.scope as any).resolve("__pg_connection__");

  const isVoidLane = rawId.endsWith("__void");
  const isModLane = !isVoidLane && rawId.endsWith("__mod");
  const id = isVoidLane
    ? rawId.slice(0, -"__void".length)
    : isModLane
      ? rawId.slice(0, -"__mod".length)
      : rawId;

  // ── ItemReceipt MOD lane ─────────────────────────────────────────────────
  if (isModLane) {
    const rows = await knex
      .raw(
        `SELECT id FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status        = 'completed',
              mod_last_error    = NULL,
              mod_next_retry_at = NULL,
              mod_synced_at     = NOW(),
              updated_at        = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Marked as fixed" });
  }

  // ── ItemReceipt VOID/DELETE lane ────────────────────────────────────────
  if (isVoidLane) {
    const rows = await knex
      .raw(
        `SELECT id FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET void_status        = 'synced',
              void_last_error    = NULL,
              void_next_retry_at = NULL,
              void_synced_at     = NOW(),
              updated_at         = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Marked as fixed" });
  }

  // ── ItemReceipt ADD lane ────────────────────────────────────────────────
  if (id.startsWith("qbrcpipe_")) {
    const rows = await knex
      .raw(
        `SELECT id FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET status        = 'synced',
              last_error    = NULL,
              next_retry_at = NULL,
              synced_at     = NOW(),
              updated_at    = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Marked as fixed" });
  }

  // ── Purchase Order pipeline (default) ───────────────────────────────────
  const rows = await knex
    .raw(
      `SELECT id, status FROM qb_purchase_order_pipeline WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id]
    )
    .then((r: any) => r.rows);

  if (!rows[0])
    return res.status(404).json({ error: "Pipeline entry not found" });

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
