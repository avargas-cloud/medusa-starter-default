/**
 * src/lib/purchase-orders/po-billed-quantities.ts
 *
 * How much of a purchase order is still billable.
 *
 * A vendor can ship one PO across several deliveries and invoice each one
 * separately, and those invoices routinely arrive BEFORE the goods do — so
 * item receipts cannot be what splits the PO across bills. The split has to be
 * carried by the quantities themselves: each regular bill claims part of the
 * ordered quantity, and what is left over is what the next bill may claim.
 *
 * That makes "remaining" the single number every path needs:
 *   - creating a bill from a PO seeds its lines with the remainder,
 *   - "Fill from PO" on an empty bill does the same,
 *   - saving a bill caps each line at the remainder instead of at the raw
 *     ordered quantity.
 *
 * The third one is the load-bearing one. Before multiple PO-sourced bills were
 * possible, the save route capped a line at `qty_ordered - qty_cancelled` and
 * that was airtight, because only one bill could ever hold that PO line. With
 * two bills it stops being a cap at all: a line ordered 1 could be billed 1 on
 * bill A and 1 again on bill B, and the same unit gets paid twice, averaged
 * into cost twice, and posted to QuickBooks twice. So the cap and the seed must
 * read the same subtraction, from here.
 *
 * WHAT RESERVES QUANTITY
 * Bills in `draft`, `confirmed` and `synced`, that are not soft-deleted. A
 * draft reserves on purpose: the whole workflow this exists for is two drafts
 * sitting side by side waiting for the merchandise. `deleted`, `cancelled` and
 * `voided` release what they held — `deleted_at` alone is not enough, because
 * cancel/void leave it NULL (see .claude/rules/purchasing-po-fo.md).
 *
 * SCOPE
 * Quantities only. Nothing here writes, touches receipts, or knows about
 * QuickBooks. Whether a bill may be CONFIRMED is a separate question answered
 * by the confirm route, which still requires the goods to have been received.
 */

/** Bill statuses whose quantities are reserved against the PO. */
export const ACTIVE_BILL_STATUSES = [
  "draft",
  "confirmed",
  "synced",
] as const;

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** One PO line, with everything a seeded bill line needs. */
export interface RemainingPoLine {
  purchase_order_line_id: string;
  product_variant_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  /** `qty_ordered - qty_cancelled`, floored at 0. */
  qty_ordered: number;
  /** Sum of active bill lines for this PO line, excluding the caller's bill. */
  qty_billed: number;
  /** `qty_ordered - qty_billed`, floored at 0. What a new bill may claim. */
  qty_remaining: number;
  unit_cost_cents: number;
  metadata: Record<string, unknown> | null;
  /** Number of the bill holding the largest share, for the error message. */
  billed_on: string | null;
}

/**
 * Every open line of `purchaseOrderId` with its remaining quantity.
 *
 * `excludeBillId` takes the caller's own bill out of the "already billed"
 * sum. Without it a save would validate a bill against itself: a line already
 * carrying 3 units would see 3 as billed, compute 0 remaining, and refuse to
 * save the very quantity it already holds.
 *
 * Cancelled PO lines and lines with nothing left ordered are dropped, matching
 * what the create/fill routes have always seeded.
 */
export async function resolveRemainingPoQuantities(
  db: Knex,
  purchaseOrderId: string,
  excludeBillId: string | null = null
): Promise<RemainingPoLine[]> {
  const result = await db.raw(
    `WITH billed AS (
       SELECT vbl.purchase_order_line_id                    AS po_line_id,
              SUM(COALESCE(vbl.qty, 0))::int                AS qty_billed,
              (ARRAY_AGG(
                 vb.number ORDER BY COALESCE(vbl.qty, 0) DESC, vb.id
               ))[1]                                        AS billed_on
         FROM vendor_bill_line vbl
         JOIN vendor_bill vb
           ON vb.id = vbl.vendor_bill_id
          AND vb.deleted_at IS NULL
          AND vb.bill_type = 'regular'
          AND vb.status = ANY(?)
        WHERE vbl.deleted_at IS NULL
          AND COALESCE(vbl.line_type, 'product') = 'product'
          AND vbl.purchase_order_line_id IS NOT NULL
          AND (?::text IS NULL OR vb.id <> ?::text)
        GROUP BY vbl.purchase_order_line_id
     )
     SELECT pol.id                                          AS purchase_order_line_id,
            pol.product_variant_id,
            pol.sku_snapshot,
            pol.description_snapshot,
            GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int
                                                            AS qty_ordered,
            COALESCE(billed.qty_billed, 0)::int             AS qty_billed,
            GREATEST(
              GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)
                - COALESCE(billed.qty_billed, 0),
              0
            )::int                                          AS qty_remaining,
            COALESCE(pol.unit_cost_cents, 0)::int           AS unit_cost_cents,
            pv.metadata,
            billed.billed_on
       FROM purchase_order_line pol
       LEFT JOIN billed ON billed.po_line_id = pol.id
       LEFT JOIN product_variant pv
         ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
      WHERE pol.purchase_order_id = ?
        AND pol.deleted_at IS NULL
        AND COALESCE(pol.status, 'open') <> 'cancelled'
        AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) > 0
      ORDER BY pol.created_at, pol.id`,
    [
      [...ACTIVE_BILL_STATUSES],
      excludeBillId,
      excludeBillId,
      purchaseOrderId,
    ]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    purchase_order_line_id: row.purchase_order_line_id as string,
    product_variant_id: row.product_variant_id as string,
    sku_snapshot: (row.sku_snapshot as string) ?? "",
    description_snapshot: (row.description_snapshot as string) ?? "",
    qty_ordered: Number(row.qty_ordered ?? 0),
    qty_billed: Number(row.qty_billed ?? 0),
    qty_remaining: Number(row.qty_remaining ?? 0),
    unit_cost_cents: Number(row.unit_cost_cents ?? 0),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    billed_on: (row.billed_on as string | null) ?? null,
  }));
}

/** Lines a new bill should be seeded with: only what is still unbilled. */
export function seedableLines(lines: RemainingPoLine[]): RemainingPoLine[] {
  return lines.filter((line) => line.qty_remaining > 0);
}

/** Total units still unbilled across the PO. */
export function totalRemaining(lines: RemainingPoLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty_remaining, 0);
}

/**
 * The message a rejected quantity gets.
 *
 * Deliberately says where the missing units went. "Max is the PO quantity (1)"
 * is a dead end when another bill is holding the difference — the operator has
 * no way to tell an over-count from a quantity legitimately parked on the
 * sibling invoice, which is the normal case in a split delivery.
 */
export function qtyExceedsRemainingMessage(
  line: Pick<
    RemainingPoLine,
    "qty_remaining" | "qty_ordered" | "qty_billed" | "billed_on"
  >,
  sku?: string | null
): string {
  const subject = sku ? ` for ${sku}` : "";
  if (line.qty_billed > 0) {
    const where = line.billed_on ? ` on ${line.billed_on}` : " on another bill";
    return (
      `Max is ${line.qty_remaining}${subject} — ` +
      `${line.qty_billed} of the ${line.qty_ordered} ordered ` +
      `${line.qty_billed === 1 ? "unit is" : "units are"} already billed${where}.`
    );
  }
  return `Max is the PO quantity (${line.qty_ordered})${subject}. Edit the PO to add more.`;
}
