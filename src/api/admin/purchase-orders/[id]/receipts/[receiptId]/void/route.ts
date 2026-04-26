/**
 * src/api/admin/purchase-orders/[id]/receipts/[receiptId]/void/route.ts
 *
 * POST /admin/purchase-orders/:id/receipts/:receiptId/void
 *
 * Voids a previously-applied receipt: contra-applies stock, marks the
 * receipt voided, recomputes PO counters, flags the QB pipeline for
 * TxnVoid. Hard-rejects if the reversal would leave stock negative.
 *
 * Only applied / synced receipts can be voided — already-voided or
 * pending receipts are rejected.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { voidPurchaseOrderReceiptWorkflow } from "../../../../../../../workflows/purchase-orders/void-purchase-order-receipt";
import { getActorUserId, UnauthenticatedError } from "../../../../_lib/auth";
import { zodErrorToBody } from "../../../../_lib/format";
import { getPurchaseOrdersService } from "../../../../_lib/service-resolver";
import { voidReceiptSchema } from "../../../../_lib/validators";

interface ReceiptHeader {
  id: string;
  purchase_order_id: string;
  status: string;
  stock_location_id: string;
  voided_at: Date | string | null;
}

interface ReceiptLine {
  id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
  stock_applied: boolean;
}

export async function POST(
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
  const parsed = voidReceiptSchema.safeParse(req.body);
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
  if (receipt.status !== "applied" && receipt.status !== "synced") {
    return res.status(409).json({
      error: `Cannot void a receipt in status '${receipt.status}'. Only applied or synced receipts are voidable.`,
      code: "not_voidable",
    });
  }

  // Collect receipt lines to reverse — only those with stock_applied=true
  const rawLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptId },
    { take: 1000 }
  )) as unknown as ReceiptLine[];
  const lines_to_reverse = rawLines
    .filter((l) => l.stock_applied && l.qty_received_now > 0)
    .map((l) => ({
      receipt_line_id: l.id,
      po_line_id: l.purchase_order_line_id,
      inventory_item_id: l.inventory_item_id,
      qty_applied: l.qty_received_now,
    }));

  if (lines_to_reverse.length === 0) {
    return res.status(409).json({
      error: "Receipt has no stock-applied lines to reverse",
      code: "nothing_to_reverse",
    });
  }

  try {
    const { result } = await voidPurchaseOrderReceiptWorkflow(req.scope).run({
      input: {
        receipt_id: receiptId,
        po_id: id,
        voided_by_user_id: userId,
        void_reason: body.void_reason,
        stock_location_id: receipt.stock_location_id,
        lines_to_reverse,
      },
    });

    return res.json({ void: result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to void receipt";
    return res.status(400).json({ error: message, code: "void_failed" });
  }
}
