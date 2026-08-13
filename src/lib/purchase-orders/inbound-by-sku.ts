/**
 * src/lib/purchase-orders/inbound-by-sku.ts
 *
 * What is still coming for ONE SKU, broken down by the deliveries carrying it.
 *
 * WHY THIS IS NOT `/on-order`
 * `/on-order` answers with a single number: how many units of a SKU are pending
 * across active POs. That number is authoritative and stays that way — this file
 * does not recompute it differently, it DECOMPOSES it. A cashier looking at a
 * line item wants to know not just "12 more are coming" but "8 land Aug 12 on a
 * FedEx waybill, and 4 have no shipment yet".
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 *
 *     on_order == Σ(deliveries[].qty) + unassigned
 *
 * It must hold on every response. When a PO's allocations exceed what is still
 * pending — cancellations applied after the goods were allocated to a shipment
 * can do this — the totals are NOT quietly clamped into agreement. `inconsistent`
 * is raised and the screen says so. A stock figure that silently adjusts itself
 * to look tidy is worse than one that admits it disagrees.
 *
 * WHY `unassigned` IS A FIRST-CLASS FIELD, NOT A ROUNDING ERROR
 * Most POs carry no tracking at all for most of their life: submitted today,
 * waybill three days later. Those units are ordered, real, and on nobody's
 * shipment. Listing only deliveries would show "On Order 50" above rows summing
 * to 20 and read as if the system lost 30 units. `unassigned` is the row that
 * makes the arithmetic close, and it is the most common row on this screen.
 *
 * SHIPMENTS ARE READ THROUGH `resolvePoShipments`, NEVER RE-QUERIED HERE.
 * That reader is the single source for a PO's deliveries (see its header note).
 * The quantity math below is deliberately NOT `poLineTrackingViews`: that helper
 * answers "what does the buyer's line table show", at ORDERED quantity, and this
 * screen asks "what is still in the air", at PENDING quantity. Same source, a
 * different question — so the query is shared and the arithmetic is not.
 */

import {
  resolvePoShipments,
  type PoShipmentView,
} from "./po-tracking-read";

/** PO lifecycle states that can still deliver something. Mirrors the API's. */
import {
  ACTIVE_PO_STATUSES,
  ACTIVE_PO_LINE_STATUSES,
} from "../../api/admin/purchase-orders/_lib/po-active-status";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface InboundNumber {
  provider: string;
  tracking_number: string;
  tracking_url: string;
}

export interface InboundDelivery {
  /** null for the synthetic "not on a shipment yet" row. */
  tracking_id: string | null;
  purchase_order_id: string;
  po_number: string | null;
  vendor_name: string | null;
  /** Units of THIS sku still travelling in this delivery. Always > 0. */
  qty: number;
  master: InboundNumber | null;
  /** Carrier numbers on this delivery; a truck with two waybills reports 2. */
  number_count: number;
  /**
   * The carrier says this delivery already arrived, while these units are still
   * outstanding in the system — nobody has posted the receipt yet.
   *
   * This is a real and common operating state, not an error: goods land at the
   * dock hours or days before someone records them. The screen says so instead
   * of hiding the shipment, because "arrived but not received" is exactly the
   * backlog a buyer needs to see.
   */
  delivered: boolean;
  /** YYYY-MM-DD, or null when nothing is known. */
  eta: string | null;
  eta_source: "carrier" | "expected" | "none";
  /** True when the ETA is in the past and the carrier has not said delivered. */
  overdue: boolean;
}

export interface InboundBySku {
  sku: string;
  /** Authoritative pending count. Identical to `/on-order` for the same SKU. */
  on_order: number;
  /** Σ of the delivery rows. */
  in_transit: number;
  /** Pending units on no shipment. `on_order - in_transit`, floored at 0. */
  unassigned: number;
  /** Allocations exceed what is pending — surfaced, never smoothed over. */
  inconsistent: boolean;
  deliveries: InboundDelivery[];
}

interface LineRow {
  line_id: string;
  purchase_order_id: string;
  po_number: string | null;
  vendor_name: string | null;
  expected_at: string | null;
  qty_ordered: unknown;
  qty_received: unknown;
  qty_cancelled: unknown;
}

/** Postgres numerics arrive as strings over the wire — the row type lies. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

/**
 * Units of one PO line that a shipment claims to carry.
 *
 * An `all_order` shipment stores no allocation rows — it claims the whole line,
 * so its quantity is everything still shippable (`ordered - cancelled`).
 * Received units are NOT subtracted here; that is the FIFO pass below.
 */
function claimedBy(
  shipment: PoShipmentView,
  lineId: string,
  shippable: number
): number {
  if (shipment.scope === "all_order") return shippable;
  let qty = 0;
  for (const alloc of shipment.lines) {
    if (alloc.purchase_order_line_id === lineId) qty += num(alloc.qty);
  }
  return qty;
}

/**
 * Which delivery brought the units that already arrived.
 *
 * THE ITEM RECEIPT IS THE ONLY AUTHORITY ON HOW MANY UNITS ARRIVED.
 * `purchase_order_receipt` is what says goods entered the building. The
 * carrier's `delivered` flag says where the box is, which is a different fact
 * and a weaker one: receiving lags the truck by hours or days whenever the crew
 * is busy, and that lag is a staffing reality, not a data error.
 *
 * So `delivered` never CONSUMES a unit. It only breaks the tie about WHICH
 * delivery the receipt should be charged to — and a tie-break can never invent
 * a unit the receipt did not record.
 *
 * THE DATA DOES NOT KNOW which waybill carried what. `purchase_order_receipt`
 * records how many units landed, not which box they rode in — the tracking model
 * says so in its own comment, deliberately. So received units are consumed off
 * the deliveries the carrier already marked `delivered` first (those are the
 * ones that demonstrably arrived), and off the OLDEST remaining ones after that,
 * because boxes generally land in the order they shipped.
 *
 * THIS USED TO BE BACKWARDS, and the bug is worth remembering: the `delivered`
 * branch consumed its whole claim regardless of `unconsumed`, so a PO whose
 * waybill UPS had marked delivered lost its tracking row the moment the carrier
 * updated — while the receipt was still unposted. The units did not vanish (the
 * invariant held), they fell into the `unassigned` bucket, which by construction
 * carries no tracking number. The screen then said "No tracking yet" about a
 * shipment that had a tracking number, had shipped, and had already landed.
 * Measured on production the day it was found: 3 POs, 24 lines, 544 units.
 *
 * This is still a heuristic and it is still confined to this function on
 * purpose. It only decides HOW a known quantity is distributed across rows; it
 * can never change `on_order`, and the invariant holds whatever it picks.
 *
 * EXPORTED FOR ITS TEST, NOT FOR REUSE. No production data exercises the tie
 * this exists for — a PO with several deliveries AND a partial receipt does not
 * occur in the sandbox — so the only place that branch is proven is
 * `src/__tests__/inbound-by-sku/fifo.unit.spec.ts`.
 */
export function inTransitPerDelivery(
  shipments: PoShipmentView[],
  lineId: string,
  shippable: number,
  received: number
): Map<string, number> {
  const out = new Map<string, number>();
  let unconsumed = received;

  // Two passes over ONE array so the relative order inside each group stays the
  // reader's order (oldest first). Delivered shipments get charged first; every
  // pass is capped by what the receipt actually recorded.
  const isDelivered = (s: PoShipmentView): boolean =>
    s.master?.carrier_status === "delivered";
  const consumptionOrder = [
    ...shipments.filter(isDelivered),
    ...shipments.filter((s) => !isDelivered(s)),
  ];

  for (const shipment of consumptionOrder) {
    const claimed = claimedBy(shipment, lineId, shippable);
    if (claimed <= 0) continue;

    const consumed = Math.min(claimed, unconsumed);
    unconsumed -= consumed;

    const stillFlying = claimed - consumed;
    if (stillFlying > 0) out.set(shipment.id, stillFlying);
  }

  // Display order belongs to the caller, which iterates `shipments` itself and
  // looks each id up here — consuming out of order never reorders the screen.
  return out;
}

/** Today in UTC, for the overdue comparison. Date-only, never a local shift. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Inbound picture for one SKU.
 *
 * `now` is injected so the overdue flag is testable without freezing the clock.
 */
export async function resolveInboundBySku(
  db: Knex,
  sku: string,
  now: Date = new Date()
): Promise<InboundBySku> {
  const empty: InboundBySku = {
    sku,
    on_order: 0,
    in_transit: 0,
    unassigned: 0,
    inconsistent: false,
    deliveries: [],
  };
  if (!sku.trim()) return empty;

  const result = (await db.raw(
    `SELECT l.id                        AS line_id,
            l.purchase_order_id         AS purchase_order_id,
            po.number                   AS po_number,
            po.vendor_name_snapshot     AS vendor_name,
            po.expected_at              AS expected_at,
            l.qty_ordered, l.qty_received, l.qty_cancelled
       FROM purchase_order_line l
       JOIN purchase_order po ON po.id = l.purchase_order_id
      WHERE l.deleted_at IS NULL
        AND po.deleted_at IS NULL
        AND l.sku_snapshot = ?
        AND l.status  = ANY (?::text[])
        AND po.status = ANY (?::text[])
      ORDER BY po.created_at DESC, l.line_order ASC, l.id ASC`,
    [sku.trim(), [...ACTIVE_PO_LINE_STATUSES], [...ACTIVE_PO_STATUSES]]
  )) as { rows: LineRow[] };

  if (!result.rows.length) return empty;

  // One shipment read per PO, not per line — a PO repeating a SKU on two lines
  // must not read its deliveries twice.
  const poIds = [...new Set(result.rows.map((r) => r.purchase_order_id))];
  const shipmentsByPo = new Map<string, PoShipmentView[]>();
  for (const poId of poIds) {
    shipmentsByPo.set(poId, await resolvePoShipments(db, poId));
  }

  const today = todayIso(now);
  const deliveries: InboundDelivery[] = [];
  const unassignedByPo = new Map<string, { qty: number; row: LineRow }>();
  let onOrder = 0;
  let inTransit = 0;

  for (const line of result.rows) {
    const ordered = num(line.qty_ordered);
    const received = num(line.qty_received);
    const cancelled = num(line.qty_cancelled);

    const pending = ordered - received - cancelled;
    if (pending <= 0) continue;
    onOrder += pending;

    const shipments = shipmentsByPo.get(line.purchase_order_id) ?? [];
    const flying = inTransitPerDelivery(
      shipments,
      line.line_id,
      Math.max(0, ordered - cancelled),
      received
    );

    let lineInTransit = 0;
    for (const shipment of shipments) {
      const qty = flying.get(shipment.id) ?? 0;
      if (qty <= 0) continue;
      lineInTransit += qty;

      const delivered = shipment.master?.carrier_status === "delivered";
      const carrierEta = shipment.carrier_eta;
      const eta = carrierEta ?? isoDate(line.expected_at);
      const etaSource = carrierEta
        ? ("carrier" as const)
        : eta
          ? ("expected" as const)
          : ("none" as const);

      // Deliveries merge across lines of the same PO: two lines of the same SKU
      // riding one truck are one row, not two.
      const existing = deliveries.find((d) => d.tracking_id === shipment.id);
      if (existing) {
        existing.qty += qty;
        continue;
      }

      deliveries.push({
        tracking_id: shipment.id,
        purchase_order_id: line.purchase_order_id,
        po_number: line.po_number,
        vendor_name: line.vendor_name,
        qty,
        master: shipment.master
          ? {
              provider: shipment.master.provider,
              tracking_number: shipment.master.tracking_number,
              tracking_url: shipment.master.tracking_url,
            }
          : null,
        number_count: shipment.numbers.length,
        eta,
        eta_source: etaSource,
        // A delivered row is never overdue and an overdue row is never
        // delivered: the two states are exclusive by construction, so a screen
        // can style them the same colour without ambiguity.
        overdue: !!eta && eta < today && !delivered,
        delivered,
      });
    }

    inTransit += lineInTransit;

    const loose = pending - lineInTransit;
    if (loose > 0) {
      const bucket = unassignedByPo.get(line.purchase_order_id);
      if (bucket) bucket.qty += loose;
      else unassignedByPo.set(line.purchase_order_id, { qty: loose, row: line });
    }
  }

  // The rows that make the arithmetic close. One per PO, always last.
  for (const [poId, bucket] of unassignedByPo) {
    const expected = isoDate(bucket.row.expected_at);
    deliveries.push({
      tracking_id: null,
      purchase_order_id: poId,
      po_number: bucket.row.po_number,
      vendor_name: bucket.row.vendor_name,
      qty: bucket.qty,
      master: null,
      number_count: 0,
      eta: expected,
      eta_source: expected ? "expected" : "none",
      overdue: false,
      // Units on no shipment at all. Nothing can have delivered them.
      delivered: false,
    });
  }

  const unassigned = Math.max(0, onOrder - inTransit);

  return {
    sku,
    on_order: onOrder,
    in_transit: inTransit,
    unassigned,
    inconsistent: inTransit > onOrder,
    deliveries,
  };
}
