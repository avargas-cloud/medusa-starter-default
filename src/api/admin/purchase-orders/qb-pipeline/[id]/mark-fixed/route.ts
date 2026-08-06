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
 *   - <uuid>__purchase_order_mod / <uuid>__item_receipt_mod
 *                               → qb_order_pipeline chained MOD rows
 *   - <uuid>__vendor_bill_mod
 *   - <uuid>__vendor_bill_rebuild_preflight / __vendor_bill_rebuild_delete
 *     are intentionally NOT mark-fixable; skipping either verification would
 *     make the dependent chain unsafe.
 *   - qbvbpipe_<ulid>__vendor_bill_delete
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

async function markDelegatedOperationFixed(
  knex: any,
  orderPipelineId: string | null | undefined
): Promise<void> {
  if (!orderPipelineId) return;
  await knex.raw(
    `UPDATE qb_order_pipeline
        SET status = 'fixed', error = NULL, next_retry_at = NULL,
            bridge_op_id = NULL, failed_at = NULL,
            confirmed_at = COALESCE(confirmed_at, NOW()),
            updated_at = NOW()
      WHERE id = ?::uuid
        AND status NOT IN ('confirmed', 'fixed')`,
    [orderPipelineId]
  );
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: rawId } = req.params as { id: string };
  const knex = (req.scope as any).resolve("__pg_connection__");

  if (
    rawId.endsWith("__vendor_bill_rebuild_preflight") ||
    rawId.endsWith("__vendor_bill_rebuild_delete")
  ) {
    return res.status(409).json({
      error:
        "Reviewed Vendor Bill rebuild steps cannot be marked fixed. Retry the step so QuickBooks verifies the real Bill state.",
      code: "vendor_bill_rebuild_mark_fixed_blocked",
    });
  }

  // ── Chained MOD history rows (append-only qb_order_pipeline) ─────────────
  // Decided before the generic `__mod` suffix below, which these ids also end
  // with and which resolves against the legacy ItemReceipt table.
  const chainedModStep = rawId.endsWith("__purchase_order_mod")
    ? "purchase_order_mod"
    : rawId.endsWith("__item_receipt_mod")
      ? "item_receipt_mod"
      : null;
  if (chainedModStep) {
    const orderPipelineId = rawId.slice(0, -`__${chainedModStep}`.length);
    const rows = await knex
      .raw(
        `SELECT id, status FROM qb_order_pipeline
          WHERE id = ?::uuid AND step = ? LIMIT 1`,
        [orderPipelineId, chainedModStep]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    // 'fixed' also unblocks whatever waits behind it in this PO's chain, which
    // is the point: the operator resolved it in QuickBooks by hand.
    await markDelegatedOperationFixed(knex, orderPipelineId);
    return res.json({
      success: true,
      message:
        chainedModStep === "purchase_order_mod"
          ? "Purchase Order modification marked as fixed"
          : "Item Receipt modification marked as fixed",
    });
  }

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
        `SELECT p.id, p.vendor_bill_id, p.intent, p.order_pipeline_id,
                COALESCE(p.qb_txn_id, vb.qb_txn_id) AS qb_txn_id
           FROM qb_vendor_bill_pipeline p
           LEFT JOIN vendor_bill vb
             ON vb.id = p.vendor_bill_id AND vb.deleted_at IS NULL
          WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
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
    // Un BillAdd marcado "fixed" sin TxnID declara éxito sobre un Bill que el
    // sistema no puede volver a encontrar: el monitor de pagos filtra por
    // `qb_txn_id IS NOT NULL` (qb-vendor-bill-payment-monitor.ts) y un BillMod
    // futuro no tiene a qué apuntar. Retry sí resuelve el caso, porque consulta
    // QuickBooks y ADOPTA el Bill existente con su TxnID (misma precedencia que
    // los pasos de rebuild, que tampoco se pueden marcar fixed).
    if (!row.qb_txn_id) {
      return res.status(409).json({
        error:
          "This Bill has no QuickBooks TxnID yet, so marking it fixed would hide it from payment checks forever. Use Retry — it queries QuickBooks first and adopts the Bill if it already exists there, without creating a duplicate.",
        code: "vendor_bill_add_mark_fixed_without_txn_id",
      });
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
    await markDelegatedOperationFixed(knex, row.order_pipeline_id);
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
        `SELECT id, mod_order_pipeline_id FROM qb_item_receipt_pipeline
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
    await markDelegatedOperationFixed(
      knex,
      rows[0].mod_order_pipeline_id
    );
    return res.json({ success: true, message: "Marked as fixed" });
  }

  // ── ItemReceipt VOID/DELETE lane ────────────────────────────────────────
  if (isVoidLane) {
    const rows = await knex
      .raw(
        `SELECT id, add_order_pipeline_id FROM qb_item_receipt_pipeline
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
    await markDelegatedOperationFixed(
      knex,
      rows[0].add_order_pipeline_id
    );
    return res.json({ success: true, message: "Marked as fixed" });
  }

  // ── ItemReceipt ADD lane ────────────────────────────────────────────────
  if (id.startsWith("qbrcpipe_")) {
    const rows = await knex
      .raw(
        `SELECT id, qb_list_id FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    if (!rows[0])
      return res.status(404).json({ error: "Pipeline entry not found" });
    // Mismo razonamiento que el BillAdd: sin el identificador de QuickBooks, el
    // "arreglado" es una afirmación que nada puede verificar después.
    if (!rows[0].qb_list_id) {
      return res.status(409).json({
        error:
          "This Item Receipt has no QuickBooks ID yet. Use Retry — it queries QuickBooks first and adopts the receipt if it already exists there, without creating a duplicate.",
        code: "item_receipt_add_mark_fixed_without_qb_id",
      });
    }
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
      `SELECT id, status, order_pipeline_id
         FROM qb_purchase_order_pipeline
        WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
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
  await markDelegatedOperationFixed(
    knex,
    rows[0].order_pipeline_id
  );

  return res.json({ success: true, message: "Marked as fixed" });
}
