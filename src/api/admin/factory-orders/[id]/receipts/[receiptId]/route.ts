/**
 * DELETE /admin/factory-orders/:id/receipts/:receiptId
 *   Hard-deletes a receipt and reverses its inventory movement.
 *   Always hard-delete — no QB tombstoning needed.
 *
 * PATCH  /admin/factory-orders/:id/receipts/:receiptId
 *   Adjusts per-line quantities on an applied receipt.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { deleteFactoryOrderReceiptWorkflow } from "../../../../../../workflows/factory-orders/delete-factory-order-receipt";
import { updateFactoryOrderReceiptWorkflow } from "../../../../../../workflows/factory-orders/update-factory-order-receipt";
import { getActorUserId, UnauthenticatedError } from "../../../_lib/auth";
import { zodErrorToBody } from "../../../_lib/format";
import { getFactoryOrdersService } from "../../../_lib/service-resolver";
import { deleteReceiptSchema, updateReceiptSchema } from "../../../_lib/validators";

interface ReceiptRow {
  id: string;
  factory_order_id: string;
  status: string;
  stock_location_id: string;
  voided_at: Date | null;
}

/**
 * Medusa's workflow engine can reject with a plain serialized object
 * `{ message }` rather than a real Error instance, so `instanceof Error`
 * misses it and the meaningful step message (e.g. RESERVED_BLOCK) is lost.
 * Pull the message out defensively.
 */
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

interface ReceiptLineRow {
  id: string;
  factory_order_receipt_id: string;
  factory_order_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
  stock_applied: boolean;
}

async function loadReceipt(
  service: ReturnType<typeof getFactoryOrdersService>,
  receiptId: string
): Promise<ReceiptRow | null> {
  return (await service
    .retrieveFactoryOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptRow | null;
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = deleteReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const deleteReason = parsed.data.delete_reason ?? "Hard delete by user";

  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as { id: string; status: string } | null;
  if (!fo) {
    return res.status(404).json({ error: "Factory order not found", code: "not_found" });
  }

  const receipt = await loadReceipt(service, receiptId);
  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.factory_order_id !== id) {
    return res.status(400).json({ error: "Receipt does not belong to this FO", code: "receipt_mismatch" });
  }

  const receiptLines = (await service.listFactoryOrderReceiptLines(
    { factory_order_receipt_id: receiptId },
    { take: 1000, skip: 0 }
  )) as unknown as ReceiptLineRow[];

  const wasAlreadyVoided = receipt.status === "voided";

  const linesToReverse = receiptLines.map((l) => ({
    receipt_line_id: l.id,
    fo_line_id: l.factory_order_line_id,
    inventory_item_id: l.inventory_item_id,
    qty_applied: l.stock_applied ? l.qty_received_now : 0,
  }));

  try {
    const { result } = await deleteFactoryOrderReceiptWorkflow(req.scope).run({
      input: {
        receipt_id: receiptId,
        fo_id: id,
        deleted_by_user_id: userId,
        delete_reason: deleteReason,
        stock_location_id: receipt.stock_location_id,
        lines_to_reverse: linesToReverse,
        was_already_voided: wasAlreadyVoided,
      },
    });
    return res.json({ delete: result });
  } catch (err) {
    const message = errMessage(err, "Failed to delete receipt");
    return res.status(400).json({ error: message, code: "delete_failed" });
  }
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = updateReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { line_qty_changes } = parsed.data;

  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as { id: string; status: string } | null;
  if (!fo) {
    return res.status(404).json({ error: "Factory order not found", code: "not_found" });
  }

  const receipt = await loadReceipt(service, receiptId);
  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.factory_order_id !== id) {
    return res.status(400).json({ error: "Receipt does not belong to this FO", code: "receipt_mismatch" });
  }
  if (receipt.status === "voided") {
    return res.status(409).json({ error: "Cannot edit a voided receipt", code: "receipt_voided" });
  }

  const receiptLines = (await service.listFactoryOrderReceiptLines(
    { factory_order_receipt_id: receiptId },
    { take: 1000, skip: 0 }
  )) as unknown as ReceiptLineRow[];

  const lineById = new Map(receiptLines.map((l) => [l.id, l]));

  const lineChanges: Array<{
    receipt_line_id: string;
    fo_line_id: string;
    inventory_item_id: string;
    new_qty: number;
    delta: number;
  }> = [];

  for (const change of line_qty_changes) {
    const line = lineById.get(change.receipt_line_id);
    if (!line) {
      return res.status(400).json({
        error: `receipt_line_id ${change.receipt_line_id} not found on this receipt`,
        code: "line_not_found",
      });
    }
    lineChanges.push({
      receipt_line_id: line.id,
      fo_line_id: line.factory_order_line_id,
      inventory_item_id: line.inventory_item_id,
      new_qty: change.new_qty,
      delta: change.new_qty - line.qty_received_now,
    });
  }

  try {
    const { result } = await updateFactoryOrderReceiptWorkflow(req.scope).run({
      input: {
        receipt_id: receiptId,
        fo_id: id,
        stock_location_id: receipt.stock_location_id,
        line_changes: lineChanges,
      },
    });
    return res.json({ update: result });
  } catch (err) {
    const message = errMessage(err, "Failed to update receipt");
    return res.status(400).json({ error: message, code: "update_failed" });
  }
}
