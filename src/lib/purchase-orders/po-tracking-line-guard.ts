/**
 * src/lib/purchase-orders/po-tracking-line-guard.ts
 *
 * Refuses a PO edit that would strand an inbound shipment.
 *
 * The PO PATCH reconciles lines by diff: lines missing from the payload are
 * hard-deleted, and a line's ordered quantity can be lowered. Either one can
 * contradict a tracking number that already claims those units — a box is on a
 * truck carrying 40 of a line the edit is about to delete.
 *
 * WHY 409 AND NOT A CASCADE
 * Cascading would quietly rewrite logistics: the operator lowers a quantity and
 * an allocation silently shrinks or vanishes, with nothing on screen saying
 * which shipment just lost its cargo. So this refuses, and the refusal NAMES
 * the tracking number, the SKU, the claimed quantity and the new ceiling. The
 * operator edits the allocation first, then the PO. That order is the point:
 * the human decides what the shipment means, not the diff.
 *
 * The RESTRICT foreign key on purchase_order_tracking_line is the backstop
 * behind this, not the user-facing behavior. If this guard is ever bypassed the
 * database still refuses — but with an error nobody can act on, which is
 * exactly why the guard exists in front of it.
 */

import { TRACKING_SCOPE_BY_LINE } from "./po-tracking-allocations";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** What one PO line has committed to shipments, for the error message. */
export interface LineAllocationClaim {
  purchase_order_line_id: string;
  sku_snapshot: string;
  /** Units of this line claimed across all live by_line trackings. */
  qty_allocated: number;
  /** Tracking numbers holding them, largest share first. */
  tracking_numbers: string[];
}

/**
 * A line the PATCH is about to lower or remove, with the ceiling it will have
 * afterwards. The route already computes this set (`reductions`) to decide the
 * vendor-bill ordering, so the guard consumes it rather than recomputing a
 * second, subtly different idea of "going down".
 *
 * `new_ceiling` is `qty_ordered - qty_cancelled` AFTER the edit, and 0 for a
 * deletion. Cancelled units are already unshippable, so leaving them in would
 * let an edit strand a shipment while the check still passed.
 */
export interface PoLineReduction {
  line_id: string;
  sku: string;
  new_ceiling: number;
  /** True when the line is being removed outright rather than lowered. */
  deleted: boolean;
}

export interface PoLineChangeRejection {
  purchase_order_line_id: string;
  sku: string;
  reason: "deleted" | "shrunk";
  qty_allocated: number;
  new_max: number;
  tracking_numbers: string[];
  message: string;
}

/**
 * What the given PO lines have committed to live `by_line` trackings.
 *
 * Returns only lines that actually carry an allocation — an empty result means
 * the edit is free to proceed.
 */
export async function resolveLineAllocationClaims(
  db: Knex,
  purchaseOrderLineIds: string[]
): Promise<LineAllocationClaim[]> {
  if (purchaseOrderLineIds.length === 0) return [];

  const result = await db.raw(
    `SELECT trkl.purchase_order_line_id,
            COALESCE(pol.sku_snapshot, '')              AS sku_snapshot,
            SUM(COALESCE(trkl.qty_allocated, 0))::int   AS qty_allocated,
            ARRAY_AGG(
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
            )                                           AS tracking_numbers
       FROM purchase_order_tracking_line trkl
       JOIN purchase_order_tracking trk
         ON trk.id = trkl.purchase_order_tracking_id
        AND trk.deleted_at IS NULL
        AND trk.scope = ?
       LEFT JOIN purchase_order_line pol
         ON pol.id = trkl.purchase_order_line_id
      WHERE trkl.deleted_at IS NULL
        AND trkl.purchase_order_line_id = ANY(?)
      GROUP BY trkl.purchase_order_line_id, pol.sku_snapshot`,
    [TRACKING_SCOPE_BY_LINE, purchaseOrderLineIds]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    purchase_order_line_id: row.purchase_order_line_id as string,
    sku_snapshot: (row.sku_snapshot as string) ?? "",
    qty_allocated: Number(row.qty_allocated ?? 0),
    tracking_numbers: (row.tracking_numbers as string[] | null) ?? [],
  }));
}

function listNumbers(numbers: string[]): string {
  if (numbers.length === 0) return "a tracking number";
  if (numbers.length === 1) return `tracking ${numbers[0]}`;
  const head = numbers.slice(0, 2).join(" and ");
  const rest = numbers.length - 2;
  return rest > 0
    ? `tracking ${head} (+${rest} more)`
    : `tracking ${head}`;
}

/**
 * Which of the reductions contradict a live shipment.
 *
 * Deletions and shrinks go through the SAME comparison — a deletion is just a
 * reduction to zero. Keeping them on one rule is deliberate: when they were two
 * checks they could disagree about a line being removed and re-added in the
 * same payload.
 */
export function poLineChangeRejections(
  claims: LineAllocationClaim[],
  reductions: PoLineReduction[]
): PoLineChangeRejection[] {
  const byId = new Map(claims.map((c) => [c.purchase_order_line_id, c]));
  const rejections: PoLineChangeRejection[] = [];

  for (const reduction of reductions) {
    const claim = byId.get(reduction.line_id);
    if (!claim || claim.qty_allocated <= 0) continue;

    const newMax = Math.max(reduction.new_ceiling, 0);
    if (claim.qty_allocated <= newMax) continue;

    const sku = claim.sku_snapshot || reduction.sku || "This line";
    const units = claim.qty_allocated === 1 ? "unit is" : "units are";
    const where = listNumbers(claim.tracking_numbers);

    rejections.push({
      purchase_order_line_id: reduction.line_id,
      sku: claim.sku_snapshot || reduction.sku,
      reason: reduction.deleted ? "deleted" : "shrunk",
      qty_allocated: claim.qty_allocated,
      new_max: newMax,
      tracking_numbers: claim.tracking_numbers,
      message: reduction.deleted
        ? `${sku} cannot be removed: ${claim.qty_allocated} ${units} on ${where}. ` +
          "Take it off that shipment first."
        : `${sku} cannot drop to ${newMax}: ${claim.qty_allocated} ${units} ` +
          `already on ${where}. Lower the shipment allocation first.`,
    });
  }

  return rejections;
}
