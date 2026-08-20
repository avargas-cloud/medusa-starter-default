/**
 * GET /admin/orders/:id/product-status
 *
 * One fetch feeding both the Product Status modal and the Separation modal:
 * per-line facts (qty, fulfilled, separated, caps, live cross-order
 * separations) plus the POs linked to the order (same DTO as
 * /purchase-orders/for-order — shared query, do not fork it).
 *
 * Read-only. All waterfall/attribution math lives client-side in
 * store-pos/components/pos/product-status/rows.ts (pure, unit-tested) — this
 * route returns FACTS, never presentation.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import { loadPosForOrder } from "../../../purchase-orders/for-order/_lib/po-for-order-query";
import { computeSeparationCaps } from "../../_lib/separation-caps";
import { deriveSeparationStatus } from "../../_lib/separation-status";
import { loadSeparationData } from "../_lib/separation-data";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id ?? "";
  if (!orderId) {
    res.status(400).json({ error: "order id is required" });
    return;
  }
  const pool = getDbPool();

  const data = await loadSeparationData(pool, orderId);
  if (!data) {
    res.status(404).json({ error: "order not found" });
    return;
  }

  const caps = new Map(
    computeSeparationCaps(data.lines, data.inventory).map((c) => [c.lineId, c])
  );

  const separation_status = deriveSeparationStatus(
    data.lines.map((l) => ({
      quantity: l.quantity,
      fulfilled: l.fulfilled,
      separated: l.separated,
    })),
    data.legacySeparatedFlag
  );

  const purchase_orders = await loadPosForOrder(pool, orderId);

  res.json({
    order: {
      id: data.orderId,
      display_id: data.displayId,
      separation_status,
      legacy_separated_flag: data.legacySeparatedFlag,
    },
    lines: data.lines.map((l) => {
      const cap = caps.get(l.lineId);
      const inv = l.inventoryItemId
        ? data.inventory.get(l.inventoryItemId)
        : undefined;
      const elsewhereRows = l.inventoryItemId
        ? data.elsewhere.get(l.inventoryItemId) ?? []
        : [];
      return {
        line_id: l.lineId,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        fulfilled: l.fulfilledActual,
        delivered: l.delivered,
        invoiced: l.invoiced,
        separated: l.separated,
        reserved: l.reserved,
        separable_cap: cap?.cap ?? 0,
        open_qty: cap?.openQty ?? 0,
        // Invoiced units still in the building: the separation may never drop
        // below this. The screen clamps its input, the POST re-validates.
        invoiced_floor: cap?.invoicedFloor ?? 0,
        // The ceiling the operator may type — pending units net of what other
        // orders and sibling lines claim. `separable_cap` above is the STOCK
        // number, kept as a warning; it does not bound the input.
        max_separable: cap?.maxSeparable ?? 0,
        miami_stocked: inv?.stocked ?? 0,
        miami_reserved_all_orders: inv?.reservedAllOrders ?? 0,
        // Live separations of OTHER orders on this item (item-level facts —
        // they repeat across lines of the same SKU, like miami_stocked).
        separated_elsewhere: inv?.separatedElsewhere ?? 0,
        separations_elsewhere: elsewhereRows.map((r) => ({
          order_id: r.orderId,
          display_id: r.displayId,
          customer_name: r.customerName,
          sku: r.sku,
          ordered: r.ordered,
          separated: r.separated,
        })),
      };
    }),
    purchase_orders,
  });
}
