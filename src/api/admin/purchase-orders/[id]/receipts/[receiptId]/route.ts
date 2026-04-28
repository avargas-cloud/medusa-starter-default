/**
 * src/api/admin/purchase-orders/[id]/receipts/[receiptId]/route.ts
 *
 * DELETE /admin/purchase-orders/:id/receipts/:receiptId
 *
 * Hard-deletes a PurchaseOrderReceipt. Restores inventory, decrements
 * qty_received on PO lines, recomputes PO header status, and (if the
 * receipt was synced to QuickBooks) queues a QB ItemReceipt delete via the
 * existing qb_item_receipt_pipeline.void_status='waiting' lane.
 *
 * Allowed receipt statuses to delete:
 *   - 'applied' / 'synced'  → full flow (contra-stock + decrement + delete)
 *   - 'voided'              → trivial purge (stock + counters already
 *                             reversed at void time; just delete the row,
 *                             waiting for QB delete sync if still pending)
 *
 * Hard-rejects 'pending' (poller hasn't even submitted yet — should be
 * cancelled via the existing pipeline mechanism) and 'deleted' (idempotency).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { deletePurchaseOrderReceiptWorkflow } from "../../../../../../workflows/purchase-orders/delete-purchase-order-receipt";
import { updatePurchaseOrderReceiptWorkflow } from "../../../../../../workflows/purchase-orders/update-purchase-order-receipt";
import { getActorUserId, UnauthenticatedError } from "../../../_lib/auth";
import { zodErrorToBody } from "../../../_lib/format";
import { getPurchaseOrdersService } from "../../../_lib/service-resolver";
import {
  deleteReceiptSchema,
  updateReceiptSchema,
} from "../../../_lib/validators";

interface ReceiptHeader {
  id: string;
  purchase_order_id: string;
  status: string;
  stock_location_id: string;
  qb_item_receipt_list_id: string | null;
  voided_at: Date | string | null;
}

interface ReceiptLine {
  id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
  stock_applied: boolean;
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = deleteReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptHeader | null;
  if (!receipt) {
    return res
      .status(404)
      .json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== id) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  const DELETABLE = ["applied", "synced", "voided"];
  if (!DELETABLE.includes(receipt.status)) {
    return res.status(409).json({
      error: `Cannot delete a receipt in status '${receipt.status}'. Only applied, synced, or voided receipts can be deleted.`,
      code: "not_deletable",
    });
  }

  const wasAlreadyVoided = receipt.status === "voided";

  // Collect lines that still need stock reversal (only for applied/synced).
  // For already-voided receipts we pass an empty list — stock parity was
  // already restored at void time.
  let linesToReverse: Array<{
    receipt_line_id: string;
    po_line_id: string;
    inventory_item_id: string;
    qty_applied: number;
  }> = [];

  if (!wasAlreadyVoided) {
    const rawLines = (await service.listPurchaseOrderReceiptLines(
      { purchase_order_receipt_id: receiptId },
      { take: 1000 }
    )) as unknown as ReceiptLine[];
    linesToReverse = rawLines
      .filter((l) => l.stock_applied && l.qty_received_now > 0)
      .map((l) => ({
        receipt_line_id: l.id,
        po_line_id: l.purchase_order_line_id,
        inventory_item_id: l.inventory_item_id,
        qty_applied: l.qty_received_now,
      }));

    if (linesToReverse.length === 0) {
      return res.status(409).json({
        error: "Receipt has no stock-applied lines to reverse",
        code: "nothing_to_reverse",
      });
    }
  }

  try {
    const { result } = await deletePurchaseOrderReceiptWorkflow(req.scope).run(
      {
        input: {
          receipt_id: receiptId,
          po_id: id,
          deleted_by_user_id: userId,
          delete_reason: body.delete_reason ?? "Hard delete by user",
          stock_location_id: receipt.stock_location_id,
          lines_to_reverse: linesToReverse,
          was_already_voided: wasAlreadyVoided,
          qb_item_receipt_list_id: receipt.qb_item_receipt_list_id,
        },
      }
    );

    return res.json({ delete: result });
  } catch (err) {
    const e = err as any;
    const message =
      err instanceof Error
        ? err.message
        : typeof e?.message === "string"
          ? e.message
          : Array.isArray(e?.errors) &&
              typeof e.errors[0]?.error?.message === "string"
            ? e.errors[0].error.message
            : "Failed to delete receipt";
    console.error("[delete-receipt] FAILED", {
      message,
      stack: err instanceof Error ? err.stack : e?.stack,
      cause: err instanceof Error ? (err as any).cause : e?.cause,
    });
    return res.status(400).json({ error: message, code: "delete_failed" });
  }
}

interface ReceiptLineRow {
  id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
  stock_applied: boolean;
}

interface PoLineRow {
  id: string;
  qty_ordered: number;
  qty_received: number;
}

/**
 * PATCH /admin/purchase-orders/:id/receipts/:receiptId
 *
 * Edits an applied receipt:
 *   - vendor_bill_number (packing slip #) — metadata-only update.
 *   - line_qty_changes — adjusts inventory_levels by delta, updates the
 *     receipt line, and recomputes PO line + header counters.
 *
 * Hard-rejects:
 *   - status not in ['applied']  (synced→409 with hint to delete+recreate;
 *                                 voided/error/pending→409 generic).
 *   - new_qty would push a PO line over qty_ordered (cross-receipt sum).
 *   - delta would drive inventory negative at the location.
 */
export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = updateReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptHeader | null;
  if (!receipt) {
    return res
      .status(404)
      .json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== id) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  if (receipt.status !== "applied") {
    if (receipt.status === "synced") {
      return res.status(409).json({
        error:
          "Receipt is already synced to QuickBooks. Delete and recreate the receipt to make corrections.",
        code: "not_editable_synced",
      });
    }
    return res.status(409).json({
      error: `Cannot edit a receipt in status '${receipt.status}'. Only 'applied' receipts can be edited.`,
      code: "not_editable",
    });
  }

  // Resolve receipt lines + PO lines so we can compute deltas + validate.
  const receiptLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptId },
    { take: 1000 }
  )) as unknown as ReceiptLineRow[];
  const receiptLineById = new Map<string, ReceiptLineRow>(
    receiptLines.map((l) => [l.id, l])
  );

  const lineChanges: Array<{
    receipt_line_id: string;
    po_line_id: string;
    inventory_item_id: string;
    new_qty: number;
    delta: number;
  }> = [];

  if (body.line_qty_changes && body.line_qty_changes.length > 0) {
    const poLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: id },
      { take: 1000 }
    )) as unknown as PoLineRow[];
    const poLineById = new Map<string, PoLineRow>(
      poLines.map((p) => [p.id, p])
    );

    for (const change of body.line_qty_changes) {
      const rl = receiptLineById.get(change.receipt_line_id);
      if (!rl) {
        return res.status(400).json({
          error: `Receipt line ${change.receipt_line_id} not found on this receipt`,
          code: "line_not_found",
        });
      }
      const pol = poLineById.get(rl.purchase_order_line_id);
      if (!pol) {
        return res.status(400).json({
          error: `PO line ${rl.purchase_order_line_id} not found on this PO`,
          code: "po_line_not_found",
        });
      }

      const delta = change.new_qty - rl.qty_received_now;

      // Cross-receipt cap: total received on this PO line (current snapshot
      // already includes this receipt's prior value) + delta must not exceed
      // qty_ordered.
      const newPoLineReceived = pol.qty_received + delta;
      if (newPoLineReceived > pol.qty_ordered) {
        return res.status(400).json({
          error: `New qty (${change.new_qty}) would exceed open quantity on PO line ${pol.id}. Ordered: ${pol.qty_ordered}, already received across all receipts: ${pol.qty_received - rl.qty_received_now}, max allowed for this receipt: ${pol.qty_ordered - (pol.qty_received - rl.qty_received_now)}.`,
          code: "exceeds_open_qty",
        });
      }
      if (newPoLineReceived < 0) {
        return res.status(400).json({
          error: `New qty (${change.new_qty}) would drive PO line ${pol.id} qty_received negative.`,
          code: "negative_po_qty",
        });
      }

      lineChanges.push({
        receipt_line_id: rl.id,
        po_line_id: pol.id,
        inventory_item_id: rl.inventory_item_id,
        new_qty: change.new_qty,
        delta,
      });
    }
  }

  const vendor_bill_number_changed = body.vendor_bill_number !== undefined;

  try {
    const { result } = await updatePurchaseOrderReceiptWorkflow(req.scope).run(
      {
        input: {
          receipt_id: receiptId,
          po_id: id,
          stock_location_id: receipt.stock_location_id,
          vendor_bill_number: vendor_bill_number_changed
            ? (body.vendor_bill_number ?? null)
            : null,
          vendor_bill_number_changed,
          line_changes: lineChanges,
        },
      }
    );

    return res.json({ update: result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update receipt";
    console.error("[update-receipt] FAILED", {
      message,
      stack: err instanceof Error ? err.stack : undefined,
      cause: err instanceof Error ? (err as any).cause : undefined,
    });
    return res.status(400).json({ error: message, code: "update_failed" });
  }
}
