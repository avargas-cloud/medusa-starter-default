/**
 * POST /admin/purchase-orders/qb-pipeline/:id/mark-fixed
 *
 * Acknowledges a failed/errored pipeline entry as manually resolved in QB
 * Desktop. Branches on id prefix:
 *   - qbpopipe_<ulid>           → qb_purchase_order_pipeline
 *   - qbrcpipe_<ulid>           → qb_item_receipt_pipeline ADD lane
 *   - qbrcpipe_<ulid>__mod      → qb_item_receipt_pipeline MOD lane
 *   - qbrcpipe_<ulid>__void     → qb_item_receipt_pipeline VOID/DELETE lane
 *   - qbvbpipe_<ulid>__vendor_bill_add
 *   - <uuid>__vendor_bill_mod
 *   - qbvbpipe_<ulid>__vendor_bill_delete
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: rawId } = req.params as { id: string };
  const knex = (req.scope as any).resolve("__pg_connection__");

  const isVendorBillAdd = rawId.endsWith("__vendor_bill_add");
  const isVendorBillMod = rawId.endsWith("__vendor_bill_mod");
  const isVendorBillDelete = rawId.endsWith("__vendor_bill_delete");
  const vendorBillSuffix = isVendorBillAdd
    ? "__vendor_bill_add"
    : isVendorBillMod
      ? "__vendor_bill_mod"
      : isVendorBillDelete
        ? "__vendor_bill_delete"
        : null;
  const vendorBillId = vendorBillSuffix
    ? rawId.slice(0, -vendorBillSuffix.length)
    : null;

  if (isVendorBillAdd && vendorBillId) {
    const rows = await knex
      .raw(
        `SELECT id, vendor_bill_id, intent FROM qb_vendor_bill_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.intent !== "add") {
      return res
        .status(409)
        .json({ error: "The original BillAdd is historical" });
    }
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'synced', last_error = NULL, next_retry_at = NULL,
              synced_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [vendorBillId]
    );
    await knex.raw(
      `UPDATE vendor_bill SET status = 'synced', qb_synced_at = NOW(), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [row.vendor_bill_id]
    );
    return res.json({
      success: true,
      message: "Vendor Bill add marked as fixed",
    });
  }

  if (isVendorBillMod && vendorBillId) {
    const rows = await knex
      .raw(
        `SELECT id, reference_id FROM qb_order_pipeline
          WHERE id = ?::uuid AND step = 'vendor_bill_mod' LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    await knex.raw(
      `UPDATE qb_order_pipeline
          SET status = 'fixed', error = NULL, next_retry_at = NULL,
              confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW()
        WHERE id = ?::uuid`,
      [vendorBillId]
    );
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'synced', last_error = NULL, next_retry_at = NULL,
              synced_at = NOW(), updated_at = NOW()
        WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [row.reference_id]
    );
    await knex.raw(
      `UPDATE vendor_bill SET status = 'synced', qb_synced_at = NOW(), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [row.reference_id]
    );
    return res.json({
      success: true,
      message: "Vendor Bill modification marked as fixed",
    });
  }

  if (isVendorBillDelete && vendorBillId) {
    const rows = await knex
      .raw(
        `SELECT id FROM qb_vendor_bill_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET void_status = 'synced', void_last_error = NULL,
              void_next_retry_at = NULL, updated_at = NOW()
        WHERE id = ?`,
      [vendorBillId]
    );
    return res.json({
      success: true,
      message: "Vendor Bill delete marked as fixed",
    });
  }

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
