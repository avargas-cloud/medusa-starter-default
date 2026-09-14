/**
 * src/lib/purchase-orders/po-line-shipping.ts
 *
 * What is in the air for EACH LINE of a set of POs, with the carrier numbers
 * that are actually carrying it.
 *
 * WHY THIS EXISTS
 * `loadPosForOrder` used to flatten a PO's tracking numbers and hand the same
 * list to every SKU on the PO. That was written before `by_line` shipments
 * existed, and once they did the Product Status modal quoted a customer the
 * waybill — and the delivery date — of a box that carried a DIFFERENT product.
 * Found on S11581 / PO-1160 (2026-09-14): the fan had not shipped at all, and
 * the screen said "delivered Sep 3".
 *
 * THE ARITHMETIC IS NOT NEW. `inTransitPerDelivery` (inbound-by-sku.ts) already
 * decides how received units are charged against shipments — delivered ones
 * first, then oldest — and this file reuses it verbatim. The stock modal and
 * the Product Status modal must give ONE answer to "what is still flying for
 * this line", so they share the function that computes it.
 *
 *     in_transit == Σ over shipments of (claimed − consumed by receipts)
 *     shipped    == Σ claimed  (what the vendor put on a truck, ever)
 *
 * A tracking number is listed on a line ONLY while that shipment still has
 * units of the line in flight. Once the receipt covers them, the number drops
 * off the line — a waybill that already landed is noise that reads as "the
 * rest is coming".
 */

import { claimedBy, inTransitPerDelivery } from "./inbound-by-sku";
import { resolvePoShipments, type PoShipmentView } from "./po-tracking-read";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface LineShippingTracking {
  id: string;
  provider: string;
  tracking_number: string;
  tracking_url: string;
  carrier_eta: string | null;
  carrier_status: string | null;
  carrier_detail: string | null;
  /** Units of THIS line still flying on this shipment. Always > 0. */
  qty: number;
}

export interface LineShipping {
  /** Units of the line ever placed on a shipment (`all_order` claims the whole line). */
  shipped: number;
  /** shipped − what the receipts already consumed, per `inTransitPerDelivery`. */
  in_transit: number;
  /** Only the numbers of shipments with units of this line in flight. */
  tracking: LineShippingTracking[];
}

export interface LineShippingInput {
  line_id: string;
  purchase_order_id: string;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
}

/** Postgres numerics can arrive as strings — coerce before math. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure half — exported for its unit test. Given a PO's shipments and one line's
 * quantities, the shipping picture of that line.
 */
export function lineShippingOf(
  shipments: PoShipmentView[],
  line: LineShippingInput
): LineShipping {
  const shippable = Math.max(0, num(line.qty_ordered) - num(line.qty_cancelled));
  const received = num(line.qty_received);

  let shipped = 0;
  for (const s of shipments) shipped += claimedBy(s, line.line_id, shippable);

  const flying = inTransitPerDelivery(shipments, line.line_id, shippable, received);

  const tracking: LineShippingTracking[] = [];
  let inTransit = 0;
  for (const s of shipments) {
    const qty = flying.get(s.id) ?? 0;
    if (qty <= 0) continue;
    inTransit += qty;
    // Master first — the number a screen quotes when it has room for one.
    for (const n of s.numbers) {
      tracking.push({
        id: n.id,
        provider: n.provider,
        tracking_number: n.tracking_number,
        tracking_url: n.tracking_url,
        carrier_eta: n.effective_eta,
        carrier_status: n.carrier_status,
        carrier_detail: n.carrier_detail,
        qty,
      });
    }
  }

  return { shipped, in_transit: inTransit, tracking };
}

/**
 * One shipment read per PO, then the pure half per line. Keyed by line id.
 *
 * `db` is the `__pg_connection__` knex pool (`?` placeholders) that
 * `resolvePoShipments` expects — NOT the pg Pool the caller may also hold.
 */
export async function resolveLineShipping(
  db: Knex,
  lines: LineShippingInput[]
): Promise<Map<string, LineShipping>> {
  const poIds = [...new Set(lines.map((l) => l.purchase_order_id))];
  const shipmentsByPo = new Map<string, PoShipmentView[]>();
  for (const poId of poIds) {
    shipmentsByPo.set(poId, await resolvePoShipments(db, poId));
  }

  const out = new Map<string, LineShipping>();
  for (const line of lines) {
    out.set(
      line.line_id,
      lineShippingOf(shipmentsByPo.get(line.purchase_order_id) ?? [], line)
    );
  }
  return out;
}
