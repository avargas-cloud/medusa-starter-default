/**
 * GET /admin/purchase-orders/on-order?sku=XXX
 *
 * Returns the total pending (not yet received) units for a given SKU across
 * all submitted/partially_received purchase orders.
 *
 * Used by the POS item search and stock popup to show "On Order" quantities.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getPurchaseOrdersService } from "../_lib/service-resolver";

const ACTIVE_STATUSES = ["submitted", "partially_received"] as const;
const ACTIVE_LINE_STATUSES = ["open", "partial"] as const;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const sku = (req.query.sku as string | undefined)?.trim();
  if (!sku) {
    return res.status(400).json({ error: "sku query param is required" });
  }

  const service = getPurchaseOrdersService(req);

  // All lines for this SKU regardless of PO status — we filter next.
  const lines = (await service.listPurchaseOrderLines(
    { sku_snapshot: sku },
    { take: 1000, skip: 0 }
  )) as Array<{
    purchase_order_id: string;
    product_variant_id: string;
    qty_ordered: number;
    qty_received: number;
    qty_cancelled: number;
    status: string;
  }>;

  if (!lines.length) {
    return res.json({ on_order: 0 });
  }

  // Check which parent POs are in an active (ordering) status.
  const poIds = [...new Set(lines.map((l) => l.purchase_order_id))];
  const activePOs = new Set<string>();
  try {
    const pos = (await service.listPurchaseOrders(
      { id: poIds, status: ACTIVE_STATUSES },
      { take: 1000, skip: 0 }
    )) as Array<{ id: string }>;
    for (const po of pos) activePOs.add(po.id);
  } catch {
    return res.json({ on_order: 0 });
  }

  let onOrder = 0;
  for (const line of lines) {
    if (!activePOs.has(line.purchase_order_id)) continue;
    if (!(ACTIVE_LINE_STATUSES as readonly string[]).includes(line.status)) continue;
    const pending = line.qty_ordered - line.qty_received - line.qty_cancelled;
    if (pending > 0) onOrder += pending;
  }

  return res.json({ on_order: onOrder });
}
