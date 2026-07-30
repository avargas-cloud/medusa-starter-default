/**
 * src/lib/purchase-orders/po-tracking-allocations.ts
 *
 * How much of a purchase order line is still free to put on a tracking number.
 *
 * A vendor ships one PO across several boxes, and each box carries specific
 * goods: a line ordered 100 can travel 40 in one shipment and 60 in the next.
 * So "which tracking number covers this PO" stops being a yes/no and becomes a
 * quantity, and the same subtraction has to serve three callers:
 *   - the editor seeds a new tracking with what is left over,
 *   - saving an allocation caps each line at that leftover,
 *   - the PO PATCH refuses to delete or shrink a line that shipments claim.
 *
 * The middle one is load-bearing. Without a shared cap, a line ordered 1 could
 * be allocated 1 on tracking A and 1 again on tracking B, and the PO would
 * report 200% of its units in transit.
 *
 * WHAT RESERVES QUANTITY
 * Only `by_line` trackings that are not soft-deleted. An `all_order` tracking
 * reserves NOTHING, on purpose: it means "this number covers the PO, but the
 * quantities were never distributed". If it consumed the ordered qty, the first
 * all-order entry would swallow the PO and a second number could never be
 * added — which is the exact situation this whole feature exists for.
 *
 * THE CEILING IS `qty_ordered - qty_cancelled`
 * Cancelled units are not shippable, so they leave. `qty_received` does NOT:
 * a unit that already arrived still belongs, historically, to the number that
 * carried it. Subtracting received units would make an allocation evaporate the
 * moment the goods land, and the shipment history would rewrite itself.
 *
 * SCOPE
 * Quantities only. Nothing here writes, touches receipts or inventory, or knows
 * about QuickBooks — inbound tracking has never synced to QB. Which allocation
 * is still in transit after a partial receive is a question this file
 * deliberately does not answer.
 */

/** Tracking scopes. Only `by_line` participates in the cap. */
export const TRACKING_SCOPE_ALL_ORDER = "all_order";
export const TRACKING_SCOPE_BY_LINE = "by_line";

export type TrackingScope =
  | typeof TRACKING_SCOPE_ALL_ORDER
  | typeof TRACKING_SCOPE_BY_LINE;

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** One PO line, with everything the tracking editor needs to show a row. */
export interface AllocatablePoLine {
  purchase_order_line_id: string;
  product_variant_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  /** `qty_ordered - qty_cancelled`, floored at 0. The ceiling. */
  qty_ordered: number;
  /** Units of this line already claimed by OTHER by_line trackings. */
  qty_allocated_elsewhere: number;
  /** `qty_ordered - qty_allocated_elsewhere`, floored at 0. */
  qty_remaining: number;
  /** Tracking number holding the largest share elsewhere, for the message. */
  allocated_on: string | null;
  line_order: number;
}

/**
 * Every live line of `purchaseOrderId` with what a tracking number may claim.
 *
 * `excludeTrackingId` takes the caller's own tracking out of the "allocated
 * elsewhere" sum. Without it, editing a tracking would validate it against
 * itself: a line already carrying 40 would see 40 as taken, compute a remainder
 * that excludes its own units, and refuse to save the quantity it already
 * holds.
 *
 * Cancelled lines and lines with nothing left ordered are dropped — they can
 * never be shipped, so offering them in the editor would be a trap.
 */
export async function resolveAllocatablePoLines(
  db: Knex,
  purchaseOrderId: string,
  excludeTrackingId: string | null = null
): Promise<AllocatablePoLine[]> {
  const result = await db.raw(
    `WITH allocated AS (
       SELECT trkl.purchase_order_line_id                   AS po_line_id,
              SUM(COALESCE(trkl.qty_allocated, 0))::int     AS qty_allocated,
              (ARRAY_AGG(
                 COALESCE(
                   (SELECT n.tracking_number
                      FROM purchase_order_tracking_number n
                     WHERE n.purchase_order_tracking_id = trk.id
                       AND n.deleted_at IS NULL
                     ORDER BY n.is_master DESC, n.created_at, n.id
                     LIMIT 1),
                   trk.id
                 )
                 ORDER BY COALESCE(trkl.qty_allocated, 0) DESC, trk.id
               ))[1]                                        AS allocated_on
         FROM purchase_order_tracking_line trkl
         JOIN purchase_order_tracking trk
           ON trk.id = trkl.purchase_order_tracking_id
          AND trk.deleted_at IS NULL
          AND trk.scope = ?
        WHERE trkl.deleted_at IS NULL
          AND (?::text IS NULL OR trk.id <> ?::text)
        GROUP BY trkl.purchase_order_line_id
     )
     SELECT pol.id                                          AS purchase_order_line_id,
            pol.product_variant_id,
            pol.sku_snapshot,
            pol.description_snapshot,
            GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int
                                                            AS qty_ordered,
            COALESCE(allocated.qty_allocated, 0)::int       AS qty_allocated_elsewhere,
            GREATEST(
              GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)
                - COALESCE(allocated.qty_allocated, 0),
              0
            )::int                                          AS qty_remaining,
            allocated.allocated_on,
            COALESCE(pol.line_order, 0)::int                AS line_order
       FROM purchase_order_line pol
       LEFT JOIN allocated ON allocated.po_line_id = pol.id
      WHERE pol.purchase_order_id = ?
        AND pol.deleted_at IS NULL
        AND COALESCE(pol.status, 'open') <> 'cancelled'
        AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) > 0
      ORDER BY pol.line_order, pol.created_at, pol.id`,
    [
      TRACKING_SCOPE_BY_LINE,
      excludeTrackingId,
      excludeTrackingId,
      purchaseOrderId,
    ]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    purchase_order_line_id: row.purchase_order_line_id as string,
    product_variant_id: (row.product_variant_id as string) ?? "",
    sku_snapshot: (row.sku_snapshot as string) ?? "",
    description_snapshot: (row.description_snapshot as string) ?? "",
    qty_ordered: Number(row.qty_ordered ?? 0),
    qty_allocated_elsewhere: Number(row.qty_allocated_elsewhere ?? 0),
    qty_remaining: Number(row.qty_remaining ?? 0),
    allocated_on: (row.allocated_on as string | null) ?? null,
    line_order: Number(row.line_order ?? 0),
  }));
}

/** What a requested allocation looks like coming off the wire. */
export interface RequestedAllocation {
  purchase_order_line_id: string;
  qty: number;
}

export interface AllocationRejection {
  purchase_order_line_id: string;
  sku: string;
  requested: number;
  max: number;
  message: string;
}

/**
 * The message a rejected quantity gets.
 *
 * Says where the missing units went, deliberately. "Max is 60" is a dead end
 * when a sibling shipment is holding the difference — the operator cannot tell
 * an over-count from units legitimately parked on the other box, which is the
 * normal case in a split delivery and the whole reason this exists.
 */
export function allocationExceedsMessage(
  line: Pick<
    AllocatablePoLine,
    "qty_remaining" | "qty_ordered" | "qty_allocated_elsewhere" | "allocated_on"
  >,
  sku?: string | null
): string {
  const subject = sku ? ` for ${sku}` : "";
  if (line.qty_allocated_elsewhere > 0) {
    const where = line.allocated_on
      ? ` on tracking ${line.allocated_on}`
      : " on another tracking number";
    return (
      `Max is ${line.qty_remaining}${subject} — ` +
      `${line.qty_allocated_elsewhere} of the ${line.qty_ordered} ordered ` +
      `${line.qty_allocated_elsewhere === 1 ? "unit is" : "units are"} ` +
      `already on the way${where}.`
    );
  }
  return `Max is the PO quantity (${line.qty_ordered})${subject}. Edit the PO to add more.`;
}

/**
 * Validate a whole requested allocation set against the remaining quantities.
 *
 * Returns every rejection, not just the first — an operator fixing a split
 * delivery should see all the bad rows at once instead of discovering them one
 * save at a time.
 */
export function validateAllocations(
  requested: RequestedAllocation[],
  lines: AllocatablePoLine[]
): AllocationRejection[] {
  const byId = new Map(lines.map((l) => [l.purchase_order_line_id, l]));
  const rejections: AllocationRejection[] = [];

  for (const req of requested) {
    const line = byId.get(req.purchase_order_line_id);
    if (!line) {
      rejections.push({
        purchase_order_line_id: req.purchase_order_line_id,
        sku: "",
        requested: req.qty,
        max: 0,
        message:
          "That line is not on this purchase order, or it was cancelled. " +
          "Reopen the tracking editor to reload the current lines.",
      });
      continue;
    }
    if (req.qty > line.qty_remaining) {
      rejections.push({
        purchase_order_line_id: req.purchase_order_line_id,
        sku: line.sku_snapshot,
        requested: req.qty,
        max: line.qty_remaining,
        message: allocationExceedsMessage(line, line.sku_snapshot),
      });
    }
  }

  return rejections;
}

/** Lines the editor should offer: only those with something left. */
export function allocatableLines(
  lines: AllocatablePoLine[]
): AllocatablePoLine[] {
  return lines.filter((line) => line.qty_remaining > 0);
}

/** Total units of this PO not yet on any by_line tracking. */
export function totalUnallocated(lines: AllocatablePoLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty_remaining, 0);
}
