/**
 * src/lib/purchase-orders/po-tracking-read.ts
 *
 * Reads a PO's inbound SHIPMENTS — what each carries, which carrier numbers
 * name it — and derives the per-line ETA that per-product tracking exists to
 * produce.
 *
 * ONE READER, ON PURPOSE. The tracking routes, the PO detail GET, the carrier
 * refresh and the cron all need the same shape. When two of them build it
 * separately they drift, and the drift shows up as a screen disagreeing with
 * the document it is describing.
 *
 * THE PER-LINE ETA IS DERIVED, NOT STORED.
 * A line's date is computed from the shipments covering it, every read. Storing
 * it on the line would put the same date in N places, and every copy is a place
 * it can go stale — a shipment's ETA moves whenever the carrier says so, and
 * nothing would repair the copies. Derived means one truth. (If a list ever
 * needs to SORT or FILTER by it, that is the moment to materialize a cache —
 * not before, and knowingly as a cache.)
 *
 * THE LATEST BOX WINS, TWICE OVER
 * A shipment's effective ETA is the latest among its own tracking numbers (two
 * waybills for one truck: it is not there until the last piece lands), and a
 * line's ETA is the latest among the shipments carrying it (same reason, one
 * level up). This matches what the POS Product Status modal already tells
 * customers (`resolvePoEta`).
 *
 * THIS FILE DOES NOT TOUCH `expected_at`.
 * The header date is written by lib/carrier-tracking/refresh-po.ts under a
 * policy that picks the EARLIEST upcoming ETA, and purchasing/snapshot applies
 * that single header date to every open line to decide whether the supply lands
 * inside the buying window. Flipping the header to the latest date would push
 * first-box goods out of that window and produce over-buying suggestions. So
 * the per-line ETA is derived alongside it and changes nothing about the
 * column; reconciling the two is a separate, later decision.
 */

export type TrackingCoverage = "all_order" | "by_line" | "mixed" | "none";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface TrackingNumberView {
  id: string;
  provider: string;
  tracking_number: string;
  tracking_url: string;
  is_master: boolean;
  carrier_eta: string | null;
  carrier_status: string;
  carrier_eta_fetched_at: string | null;
  carrier_detail: string | null;
}

export interface TrackingAllocationView {
  purchase_order_line_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty: number;
}

/** One inbound delivery: what it carries, and the numbers naming it. */
export interface PoShipmentView {
  id: string;
  purchase_order_id: string;
  scope: "all_order" | "by_line";
  created_at: string;
  created_by_user_id: string | null;
  numbers: TrackingNumberView[];
  lines: TrackingAllocationView[];
  /** Latest ETA among its numbers — null when none has one yet. */
  carrier_eta: string | null;
  /** The number a screen quotes when it has room for one. */
  master: TrackingNumberView | null;
}

/** One PO line's shipment picture, for the line table and the future timeline. */
export interface PoLineTrackingView {
  purchase_order_line_id: string;
  /** Latest ETA among the shipments carrying this line — null if unknown. */
  carrier_eta: string | null;
  /** Units of this line placed on a shipment. */
  qty_allocated: number;
  shipments: Array<{
    id: string;
    master_tracking_number: string;
    master_tracking_url: string;
    provider: string;
    carrier_eta: string | null;
    carrier_status: string;
    number_count: number;
    qty: number;
  }>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

function isoStamp(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

/** The later of two ISO dates, tolerating nulls. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Every live shipment of a PO, with its numbers and what it carries. */
export async function resolvePoShipments(
  db: Knex,
  purchaseOrderId: string
): Promise<PoShipmentView[]> {
  const result = await db.raw(
    `SELECT trk.id,
            trk.purchase_order_id,
            trk.scope,
            trk.created_at,
            trk.created_by_user_id,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'id',                    n.id,
                          'provider',              n.provider,
                          'tracking_number',       n.tracking_number,
                          'tracking_url',          n.tracking_url,
                          'is_master',             n.is_master,
                          'carrier_eta',           n.carrier_eta,
                          'carrier_status',        n.carrier_status,
                          'carrier_eta_fetched_at', n.carrier_eta_fetched_at,
                          'carrier_detail',        n.carrier_detail
                        )
                        ORDER BY n.is_master DESC, n.created_at, n.id
                      )
                 FROM purchase_order_tracking_number n
                WHERE n.purchase_order_tracking_id = trk.id
                  AND n.deleted_at IS NULL),
              '[]'::json
            ) AS numbers,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'purchase_order_line_id', trkl.purchase_order_line_id,
                          'sku_snapshot',          COALESCE(pol.sku_snapshot, ''),
                          'description_snapshot',  COALESCE(pol.description_snapshot, ''),
                          'qty',                   trkl.qty_allocated
                        )
                        ORDER BY COALESCE(pol.line_order, 0), trkl.purchase_order_line_id
                      )
                 FROM purchase_order_tracking_line trkl
                 LEFT JOIN purchase_order_line pol
                        ON pol.id = trkl.purchase_order_line_id
                WHERE trkl.purchase_order_tracking_id = trk.id
                  AND trkl.deleted_at IS NULL),
              '[]'::json
            ) AS lines
       FROM purchase_order_tracking trk
      WHERE trk.purchase_order_id = ?
        AND trk.deleted_at IS NULL
      ORDER BY trk.created_at, trk.id`,
    [purchaseOrderId]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const numbers = ((row.numbers as TrackingNumberView[] | null) ?? []).map(
      (n) => ({
        id: n.id,
        provider: n.provider ?? "",
        tracking_number: n.tracking_number ?? "",
        tracking_url: n.tracking_url ?? "",
        is_master: Boolean(n.is_master),
        carrier_eta: isoDate(n.carrier_eta),
        carrier_status: n.carrier_status ?? "pending",
        carrier_eta_fetched_at: isoStamp(n.carrier_eta_fetched_at),
        carrier_detail: n.carrier_detail ?? null,
      })
    );

    return {
      id: row.id as string,
      purchase_order_id: row.purchase_order_id as string,
      scope: (row.scope as "all_order" | "by_line") ?? "all_order",
      created_at: isoStamp(row.created_at) ?? "",
      created_by_user_id: (row.created_by_user_id as string | null) ?? null,
      numbers,
      // Not there until the last piece lands.
      carrier_eta: numbers.reduce<string | null>(
        (acc, n) => laterOf(acc, n.carrier_eta),
        null
      ),
      master: numbers.find((n) => n.is_master) ?? numbers[0] ?? null,
      lines: ((row.lines as TrackingAllocationView[] | null) ?? []).map((l) => ({
        purchase_order_line_id: l.purchase_order_line_id,
        sku_snapshot: l.sku_snapshot ?? "",
        description_snapshot: l.description_snapshot ?? "",
        qty: Number(l.qty ?? 0),
      })),
    };
  });
}

/**
 * Whether the PO's shipments cover it as a whole or line by line.
 *
 * `mixed` must never occur: the two modes are mutually exclusive on one PO and
 * the write path refuses to create the combination. It stays in the type as a
 * DETECTOR — legacy rows or a hand-written UPDATE could still produce it, and a
 * screen that quietly renders such a PO as normal would hide real nonsense.
 * `verify-po-tracking-allocations.ts` fails on it.
 */
export function trackingCoverage(shipments: PoShipmentView[]): TrackingCoverage {
  if (shipments.length === 0) return "none";
  const hasAllOrder = shipments.some((s) => s.scope === "all_order");
  const hasByLine = shipments.some((s) => s.scope === "by_line");
  if (hasAllOrder && hasByLine) return "mixed";
  return hasAllOrder ? "all_order" : "by_line";
}

/**
 * Per-line shipment view, keyed by PO line id.
 *
 * BOTH scopes contribute. An `all_order` shipment is not an absence of
 * information — it is the claim "everything on this PO travels in this
 * delivery", so every live line gets its numbers and its date, at full
 * quantity. A `by_line` shipment only reaches the lines it names.
 *
 * That is why the caller must pass `allLines`: an all-order shipment stores no
 * allocation rows, so the lines it covers can only come from the PO itself.
 */
export function poLineTrackingViews(
  shipments: PoShipmentView[],
  allLines: Array<{ purchase_order_line_id: string; qty_ordered: number }> = []
): Map<string, PoLineTrackingView> {
  const byLine = new Map<string, PoLineTrackingView>();

  const coveredBy = (
    s: PoShipmentView
  ): Array<{ purchase_order_line_id: string; qty: number }> =>
    s.scope === "all_order"
      ? allLines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          qty: l.qty_ordered,
        }))
      : s.lines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          qty: l.qty,
        }));

  for (const shipment of shipments) {
    for (const alloc of coveredBy(shipment)) {
      const existing = byLine.get(alloc.purchase_order_line_id) ?? {
        purchase_order_line_id: alloc.purchase_order_line_id,
        carrier_eta: null,
        qty_allocated: 0,
        shipments: [],
      };

      existing.qty_allocated += alloc.qty;
      existing.shipments.push({
        id: shipment.id,
        master_tracking_number: shipment.master?.tracking_number ?? "",
        master_tracking_url: shipment.master?.tracking_url ?? "",
        provider: shipment.master?.provider ?? "",
        carrier_eta: shipment.carrier_eta,
        carrier_status: shipment.master?.carrier_status ?? "pending",
        number_count: shipment.numbers.length,
        qty: alloc.qty,
      });

      // Latest delivery wins: the line is not complete until the last lands.
      existing.carrier_eta = laterOf(existing.carrier_eta, shipment.carrier_eta);

      byLine.set(alloc.purchase_order_line_id, existing);
    }
  }

  return byLine;
}
