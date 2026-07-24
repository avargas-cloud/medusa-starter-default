/**
 * POST /admin/vendor-bills/:id/fill-from-receipts
 *
 * Fills an EXISTING empty draft regular bill from a set of item receipts
 * (owner flow, D6/D8 + the unified hierarchical fill modal): the user checks
 * one-or-more receipts of a single PO and the bill:
 *   - adopts the receipts' PO (and its vendor, when the bill has none),
 *   - binds the receipts (purchase_order_receipt.vendor_bill_id + legacy
 *     mirror via syncPrimaryReceiptPointer),
 *   - gets its product lines from the receipt-set UNION
 *     (resolveReceiptLineUnion — same shared helper as sync-from-source and
 *     POST /admin/vendor-bills/from-receipts, so the paths never drift).
 *
 * Sibling of fill-from-po (whole-PO draft, binds NO receipts). Guards:
 *   - bill must be a draft regular bill with no product lines (bill_has_lines),
 *   - receipts must all belong to ONE PO (receipts_span_multiple_pos),
 *   - receipts must be applied/synced and not bound to another bill
 *     (receipt_already_billed), via validateReceiptsForBinding,
 *   - a bill whose vendor differs from the PO's vendor is refused
 *     (vendor_mismatch) — never silently overwritten.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  resolveReceiptLineUnion,
  syncPrimaryReceiptPointer,
  validateReceiptsForBinding,
  type RawKnex,
} from "../../../../../lib/purchase-orders/vendor-bill-receipts";

const BodySchema = z.object({
  receipt_ids: z.array(z.string().min(1)).min(1),
});

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as unknown as RawKnex;
  const id = req.params.id;
  if (!id) {
    return res.status(400).json({ error: "Vendor bill id is required" });
  }

  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "receipt_ids (non-empty string array) is required",
      code: "invalid_body",
    });
  }
  const receiptIds = [...new Set(parsed.data.receipt_ids)];

  const billResult = await knex.raw(
    `SELECT id, status, bill_type, vendor_id, purchase_order_id
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as {
    id: string;
    status: string;
    bill_type: string;
    vendor_id: string | null;
    purchase_order_id: string | null;
  } | null;
  if (!bill) {
    return res.status(404).json({ error: "Vendor bill not found" });
  }
  if (bill.status !== "draft" || bill.bill_type !== "regular") {
    return res.status(409).json({
      error: "Only draft regular bills can be filled from receipts",
      code: "not_draft_regular",
    });
  }

  const existingLineResult = await knex.raw(
    `SELECT 1 FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
        AND COALESCE(line_type, 'product') = 'product'
      LIMIT 1`,
    [id]
  );
  if (existingLineResult.rows.length > 0) {
    return res.status(409).json({
      error: "This vendor bill already has lines — use Update From… instead",
      code: "bill_has_lines",
    });
  }

  // All receipts must belong to ONE purchase order.
  const receiptsResult = await knex.raw(
    `SELECT id, purchase_order_id
       FROM purchase_order_receipt
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [receiptIds]
  );
  const receiptRows = receiptsResult.rows as Array<{
    id: string;
    purchase_order_id: string;
  }>;
  if (receiptRows.length !== receiptIds.length) {
    return res.status(404).json({
      error: "One or more receipts were not found",
      code: "receipt_not_found",
    });
  }
  const poIds = [...new Set(receiptRows.map((r) => r.purchase_order_id))];
  if (poIds.length > 1) {
    return res.status(400).json({
      error: "All receipts must belong to the same purchase order (one PO per bill)",
      code: "receipts_span_multiple_pos",
    });
  }
  const poId = poIds[0];
  if (!poId) {
    return res.status(400).json({
      error: "Receipts are missing a purchase order",
      code: "receipt_without_po",
    });
  }

  // If the bill already has a PO, the receipts must be from it.
  if (bill.purchase_order_id && bill.purchase_order_id !== poId) {
    return res.status(409).json({
      error: "The selected receipts belong to a different purchase order than this bill",
      code: "receipt_po_mismatch",
    });
  }

  const poResult = await knex.raw(
    `SELECT id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [poId]
  );
  const po = (poResult.rows[0] ?? null) as {
    id: string;
    vendor_id: string | null;
    vendor_name_snapshot: string | null;
    vendor_qb_list_id_snapshot: string | null;
  } | null;
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found" });
  }

  // Never silently repoint a bill created for a different vendor.
  if (bill.vendor_id && po.vendor_id && bill.vendor_id !== po.vendor_id) {
    return res.status(409).json({
      error:
        "This bill's vendor differs from the receipts' purchase order vendor — clear the vendor or pick that vendor's receipts",
      code: "vendor_mismatch",
    });
  }

  // Applied/synced + not bound to another bill (dual-read inside the helper).
  const validation = await validateReceiptsForBinding(knex, {
    purchaseOrderId: poId,
    billId: bill.id,
    receiptIds,
  });
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const sourceLines = await resolveReceiptLineUnion(knex, receiptIds);
  if (sourceLines.length === 0) {
    return res.status(409).json({
      error: "The selected receipts have no billable lines",
      code: "no_source_lines",
    });
  }

  // ── Writes (adopt PO/vendor → bind receipts → insert lines) ──────────────
  await knex.raw(
    `UPDATE vendor_bill
        SET purchase_order_id = ?,
            vendor_id = COALESCE(vendor_id, ?),
            vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?),
            vendor_qb_list_id_snapshot = COALESCE(vendor_qb_list_id_snapshot, ?),
            updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [
      poId,
      po.vendor_id,
      po.vendor_name_snapshot,
      po.vendor_qb_list_id_snapshot,
      id,
    ]
  );

  await knex.raw(
    `UPDATE purchase_order_receipt
        SET vendor_bill_id = ?, updated_at = NOW()
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [id, receiptIds]
  );
  await syncPrimaryReceiptPointer(knex, id);

  let insertedLines = 0;
  for (const line of sourceLines) {
    const cbmRaw = line.metadata?.cbm;
    const cbm =
      cbmRaw === undefined || cbmRaw === null || cbmRaw === ""
        ? null
        : Number(cbmRaw);
    await knex.raw(
      `INSERT INTO vendor_bill_line (
         id, vendor_bill_id, receipt_line_id, purchase_order_line_id,
         line_type, line_kind, product_variant_id, sku, mpn, description,
         qty, unit_cost_cents, cbm_per_unit,
         commission_per_unit_cents, freight_per_unit_cents,
         tariff_per_unit_cents, landed_unit_cost_cents,
         created_at, updated_at
       )
       VALUES (?, ?, NULL, ?, 'product', 'po_item', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NOW(), NOW())`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`,
        id,
        line.purchase_order_line_id,
        line.product_variant_id,
        line.sku,
        typeof line.metadata?.mpn === "string" ? line.metadata.mpn : null,
        line.description,
        line.qty,
        line.unit_cost_cents,
        cbm !== null && !Number.isNaN(cbm) ? cbm : null,
      ]
    );
    insertedLines++;
  }

  // Any linked service/freight/tariff bills follow the PO link (fill-from-po parity).
  await knex.raw(
    `UPDATE vendor_bill linked
        SET purchase_order_id = ?, updated_at = NOW()
       FROM vendor_bill regular
      WHERE regular.id = ?
        AND regular.deleted_at IS NULL
        AND linked.deleted_at IS NULL
        AND linked.id IN (
          regular.service_vendor_bill_id,
          regular.freight_vendor_bill_id,
          regular.tariff_vendor_bill_id
        )`,
    [poId, id]
  );

  return res.status(201).json({
    vendor_bill_id: id,
    inserted_lines: insertedLines,
    bound_receipts: receiptIds.length,
  });
};
