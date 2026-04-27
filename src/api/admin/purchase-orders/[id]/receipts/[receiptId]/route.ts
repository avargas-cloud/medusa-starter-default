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
import { getActorUserId, UnauthenticatedError } from "../../../_lib/auth";
import { zodErrorToBody } from "../../../_lib/format";
import { getPurchaseOrdersService } from "../../../_lib/service-resolver";
import { deleteReceiptSchema } from "../../../_lib/validators";

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
        },
      }
    );

    return res.json({ delete: result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete receipt";
    console.error("[delete-receipt] FAILED", {
      message,
      stack: err instanceof Error ? err.stack : undefined,
      cause: err instanceof Error ? (err as any).cause : undefined,
    });
    return res.status(400).json({ error: message, code: "delete_failed" });
  }
}
