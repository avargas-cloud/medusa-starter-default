/**
 * POST /admin/purchase-orders/qb-pipeline/:id/retry
 *
 * Re-queues a failed pipeline entry back to waiting. Branches by id prefix:
 *   - qbpopipe_<ulid>           → qb_purchase_order_pipeline (PO add/mod/void)
 *   - qbrcpipe_<ulid>           → qb_item_receipt_pipeline ADD lane
 *                                 (status, qb_operation_id, last_error...)
 *   - qbrcpipe_<ulid>__mod      → qb_item_receipt_pipeline MOD lane
 *                                 (mod_status, mod_operation_id, mod_*...)
 *   - qbrcpipe_<ulid>__void     → qb_item_receipt_pipeline VOID/DELETE lane
 *                                 (void_status, void_operation_id, void_*...)
 *   - qbvbpipe_<ulid>__vendor_bill_add
 *                               → qb_vendor_bill_pipeline ADD lane
 *   - <uuid>__vendor_bill_mod   → qb_order_pipeline Vendor Bill MOD row
 *   - qbvbpipe_<ulid>__vendor_bill_delete
 *                               → qb_vendor_bill_pipeline DELETE lane
 *
 * The MOD lane doesn't need a fresh-EditSequence dance before resubmitting:
 * the bridge's POST /api/item-receipts/mod always re-queries the receipt's
 * live EditSequence right before building the Mod QBXML (see bridge
 * item-receipts.ts) — a stale/missing edit_sequence in mod_payload is
 * harmless. A plain reset-and-resubmit is the correct, sufficient fix.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  orderPurchaseOrderModLines,
  type PurchaseOrderModLineLike,
} from "../../../../../../lib/quickbooks/purchase-order-line-order";
import { PURCHASE_ORDERS_MODULE } from "../../../../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../../../../modules/purchase-orders/service";

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
        `SELECT id, status, intent FROM qb_vendor_bill_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.intent !== "add") {
      return res.status(409).json({
        error: "The original BillAdd is historical and cannot be retried",
      });
    }
    if (!["waiting", "error", "failed_permanent"].includes(row.status)) {
      return res
        .status(409)
        .json({ error: `Cannot retry add lane in status '${row.status}'` });
    }
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'waiting', qb_operation_id = NULL, retries = 0,
              last_error = NULL, next_retry_at = NULL, updated_at = NOW()
        WHERE id = ?`,
      [vendorBillId]
    );
    return res.json({ success: true, message: "Vendor Bill add re-queued" });
  }

  if (isVendorBillMod && vendorBillId) {
    const rows = await knex
      .raw(
        `SELECT id, reference_id, status FROM qb_order_pipeline
          WHERE id = ?::uuid AND step = 'vendor_bill_mod' LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (!["pending", "failed"].includes(row.status)) {
      return res
        .status(409)
        .json({ error: `Cannot retry BillMod in status '${row.status}'` });
    }
    await knex.raw(
      `UPDATE qb_order_pipeline
          SET status = 'pending', bridge_op_id = NULL, retry_count = 0,
              error = NULL, next_retry_at = NULL, failed_at = NULL,
              updated_at = NOW()
        WHERE id = ?::uuid`,
      [vendorBillId]
    );
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'waiting', intent = 'mod', qb_operation_id = NULL,
              retries = 0, last_error = NULL, next_retry_at = NULL,
              updated_at = NOW()
        WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [row.reference_id]
    );
    return res.json({
      success: true,
      message: "Vendor Bill modification re-queued",
    });
  }

  if (isVendorBillDelete && vendorBillId) {
    const rows = await knex
      .raw(
        `SELECT id, void_status FROM qb_vendor_bill_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [vendorBillId]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (!["waiting", "error", "failed_permanent"].includes(row.void_status)) {
      return res.status(409).json({
        error: `Cannot retry delete lane in status '${row.void_status}'`,
      });
    }
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET void_status = 'waiting', void_operation_id = NULL,
              void_retries = 0, void_last_error = NULL,
              void_next_retry_at = NULL, updated_at = NOW()
        WHERE id = ?`,
      [vendorBillId]
    );
    return res.json({ success: true, message: "Vendor Bill delete re-queued" });
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
        `SELECT id, mod_status FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.mod_status !== "error" && row.mod_status !== "failed_permanent") {
      return res.status(409).json({
        error: `Cannot retry mod lane in status '${row.mod_status}'`,
      });
    }
    // Manual retry = fresh budget, same as the ADD lane.
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status        = 'waiting',
              mod_operation_id  = NULL,
              mod_retries       = 0,
              mod_last_error    = NULL,
              mod_next_retry_at = NULL,
              updated_at        = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Re-queued for processing" });
  }

  // ── ItemReceipt VOID/DELETE lane ────────────────────────────────────────
  if (isVoidLane) {
    const rows = await knex
      .raw(
        `SELECT id, void_status FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.void_status !== "error") {
      return res.status(409).json({
        error: `Cannot retry void/delete lane in status '${row.void_status}'`,
      });
    }
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET void_status         = 'waiting',
              void_operation_id   = NULL,
              void_last_error     = NULL,
              void_next_retry_at  = NULL,
              updated_at          = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Re-queued for processing" });
  }

  // ── ItemReceipt ADD lane ────────────────────────────────────────────────
  if (id.startsWith("qbrcpipe_")) {
    const rows = await knex
      .raw(
        `SELECT id, status FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.status !== "error" && row.status !== "failed_permanent") {
      return res.status(409).json({
        error: `Cannot retry entry with status '${row.status}'`,
      });
    }
    // Manual retry = fresh budget: reset retries so a re-queued failed_permanent
    // row isn't kicked straight back to failed_permanent on the next attempt.
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET status          = 'waiting',
              qb_operation_id = NULL,
              retries         = 0,
              last_error      = NULL,
              next_retry_at   = NULL,
              updated_at      = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Re-queued for processing" });
  }

  // ── Purchase Order pipeline (default) ───────────────────────────────────
  const service = req.scope.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;

  const rows = (await service.listQbPurchaseOrderPipelines(
    { id },
    { take: 1 }
  )) as Array<{
    id: string;
    status: string;
    payload: unknown;
    last_error: string | null;
  }>;

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Pipeline entry not found" });
  const retryableStatuses = [
    "error",
    "failed_permanent",
    "waiting",
    "submitted",
  ];
  if (!retryableStatuses.includes(row.status)) {
    return res
      .status(409)
      .json({ error: `Cannot retry entry with status '${row.status}'` });
  }

  // For mod/void: always re-query QB to get a fresh EditSequence (stale seq is the most common failure).
  const pl = (row.payload ?? {}) as Record<string, unknown>;
  const isEditSeqErr = /editsequence|edit.?sequence|3[12]00/i.test(
    row.last_error ?? ""
  );
  const needsQuery =
    (pl.is_mod || pl.is_void) && (!pl.edit_sequence || isEditSeqErr);
  // Strip _query_attempts so the re-queued query gets fresh retries.
  const { _query_attempts: _removed, ...plClean } = pl as Record<
    string,
    unknown
  >;
  const sortedLines =
    plClean.is_mod && Array.isArray(plClean.lines)
      ? orderPurchaseOrderModLines(
          plClean.lines as Array<
            PurchaseOrderModLineLike & Record<string, unknown>
          >
        )
      : undefined;
  const plOrdered = sortedLines ? { ...plClean, lines: sortedLines } : plClean;
  const newPayload = needsQuery
    ? { ...plOrdered, is_query: true, edit_sequence: undefined }
    : plOrdered;

  await knex.raw(
    `UPDATE qb_purchase_order_pipeline
        SET status          = 'waiting',
            qb_operation_id = NULL,
            payload         = ?,
            last_error      = NULL,
            next_retry_at   = NULL,
            updated_at      = NOW()
      WHERE id = ?`,
    [JSON.stringify(newPayload), id]
  );

  return res.json({ success: true, message: "Re-queued for processing" });
}
