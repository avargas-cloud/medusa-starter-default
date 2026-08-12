/**
 * GET /admin/purchase-orders/for-order?order_id=order_XXX
 *
 * Reverse lookup of the PO ↔ order link that the PO editor writes into
 * `purchase_order.linked_order_ids`. Query lives in
 * `_lib/po-for-order-query.ts`, shared with /admin/orders/:id/product-status.
 *
 * Powers the POS toolbar badge (and the legacy Product Status join). Read-only.
 * Cancelled and voided POs are excluded — they answer nothing for the
 * customer. Drafts stay in, flagged by their own `status`.
 *
 * Response: { purchase_orders: PoForOrder[] } (newest first)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import { loadPosForOrder } from "./_lib/po-for-order-query";

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = (req.query["order_id"] as string | undefined)?.trim() ?? "";

  if (!orderId) {
    res.status(400).json({ error: "order_id query param is required" });
    return;
  }
  if (!ORDER_ID_RE.test(orderId)) {
    res.status(400).json({ error: "order_id is malformed" });
    return;
  }

  const purchase_orders = await loadPosForOrder(getDbPool(), orderId);
  res.json({ purchase_orders });
}
