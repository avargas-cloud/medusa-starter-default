/**
 * src/api/admin/purchase-orders/_lib/billed-status.ts
 *
 * Derives whether a Purchase Order has been billed by the vendor, based on
 * its REGULAR vendor bills that are status IN ('confirmed', 'synced') and
 * not soft-deleted (drafts never count — nothing is committed yet).
 *
 * Rules (owner 2026-07-24, yardstick corrected 2026-08-13):
 * - billed_qty = SUM of qualifying bills' product-line qty
 *   (vendor_bill_line, deleted_at IS NULL, line_type='product').
 * - The yardstick is what was ORDERED, not what has arrived. Measuring against
 *   receipts answers "is everything that showed up invoiced", which is a
 *   different question from the one the Billed column asks, and it hides units
 *   nobody has billed yet: PO-1119 (ET2) ordered 10, received 7, billed 7, and
 *   read 'yes' with 3 units still uninvoiced.
 * - billable_ordered_qty = SUM over open lines of qty_ordered - qty_cancelled,
 *   the SAME subtraction `resolveRemainingPoQuantities` uses to answer "how
 *   much is left to bill". Both must read one definition or a PO can be fully
 *   billed and still be offered up as billable.
 * - An ADOPTED header-only bill (qb_source='adopted' with ZERO lines — a
 *   legacy import of the accountant's QB bill during reconciliation) counts
 *   as FULLY billing the PO: the reconciliation already classified it, and it
 *   has no lines by design, so its billed_qty is always 0 and an ordered-based
 *   rule would otherwise strand all 64 of them in 'partial' forever.
 * - 'no'      — no qualifying bill exists.
 * - 'yes'     — an adopted zero-line bill exists, OR billed_qty covers
 *               everything still ordered. Billed-ahead-of-receive is 'yes'
 *               when it covers the order — the vendor's invoicing timing is
 *               their call, not ours to flag.
 * - 'partial' — bills exist but leave part of the order uninvoiced.
 *
 * A PO the vendor short-ships and never finishes invoicing stays 'partial'
 * until the leftover units are cancelled, which is what takes them out of the
 * subtraction. No PO in production is in that shape today.
 */

export type BilledStatus = "no" | "partial" | "yes";

export interface BilledInfo {
  billed_status: BilledStatus;
  billed_qty: number;
}

/** Pure state derivation — no I/O. */
export function deriveBilledStatus(args: {
  billedQty: number;
  hasAdoptedZeroLineBill: boolean;
  /** `qty_ordered - qty_cancelled` summed over the PO's non-cancelled lines. */
  billableOrderedQty: number;
}): BilledInfo {
  const { billedQty, hasAdoptedZeroLineBill, billableOrderedQty } = args;

  if (billedQty <= 0 && !hasAdoptedZeroLineBill) {
    return { billed_status: "no", billed_qty: billedQty };
  }
  // billableOrderedQty <= 0 means every line was cancelled: nothing is left to
  // demand, so nothing can be outstanding.
  if (hasAdoptedZeroLineBill || billableOrderedQty <= 0 || billedQty >= billableOrderedQty) {
    return { billed_status: "yes", billed_qty: billedQty };
  }
  return { billed_status: "partial", billed_qty: billedQty };
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Enrich a page of already-loaded PO rows with billed_status via a single
 * grouped raw query keyed by PO ids. Does NOT touch pagination/counts — safe
 * to run on the paginated slice only (never join into the base query, per
 * the established china_transfer enrichment pattern).
 */
export async function enrichBilledStatusMap(
  knex: Knex,
  rows: Array<{ id: string }>
): Promise<Map<string, BilledInfo>> {
  const out = new Map<string, BilledInfo>();
  if (rows.length === 0) return out;

  const ids = rows.map((r) => r.id);
  const result = (await knex.raw(
    `WITH bill_totals AS (
       SELECT vb.id AS bill_id,
              vb.purchase_order_id AS po_id,
              vb.qb_source AS qb_source,
              COALESCE(SUM(vbl.qty), 0) AS line_qty,
              COUNT(vbl.id) AS line_count
         FROM vendor_bill vb
         LEFT JOIN vendor_bill_line vbl
                ON vbl.vendor_bill_id = vb.id
               AND vbl.deleted_at IS NULL
               AND COALESCE(vbl.line_type, 'product') = 'product'
        WHERE vb.purchase_order_id = ANY (?::text[])
          AND vb.bill_type = 'regular'
          AND vb.status IN ('confirmed', 'synced')
          AND vb.deleted_at IS NULL
        GROUP BY vb.id, vb.purchase_order_id, vb.qb_source
     ),
     billed AS (
       SELECT po_id,
              COALESCE(SUM(line_qty), 0) AS billed_qty,
              BOOL_OR(line_count = 0 AND qb_source = 'adopted') AS has_adopted_zero_line
         FROM bill_totals
        GROUP BY po_id
     ),
     ordered AS (
       SELECT pol.purchase_order_id AS po_id,
              COALESCE(SUM(
                GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)
              ), 0) AS billable_ordered_qty
         FROM purchase_order_line pol
        WHERE pol.purchase_order_id = ANY (?::text[])
          AND pol.deleted_at IS NULL
          AND COALESCE(pol.status, 'open') <> 'cancelled'
        GROUP BY pol.purchase_order_id
     )
     SELECT COALESCE(billed.po_id, ordered.po_id) AS po_id,
            COALESCE(billed.billed_qty, 0) AS billed_qty,
            COALESCE(billed.has_adopted_zero_line, false) AS has_adopted_zero_line,
            COALESCE(ordered.billable_ordered_qty, 0) AS billable_ordered_qty
       FROM billed
       FULL OUTER JOIN ordered ON ordered.po_id = billed.po_id`,
    [ids, ids]
  )) as {
    rows: Array<{
      po_id: string;
      billed_qty: string | number;
      has_adopted_zero_line: boolean;
      billable_ordered_qty: string | number;
    }>;
  };

  const byId = new Map(
    result.rows.map((r) => [
      r.po_id,
      {
        billedQty: Number(r.billed_qty ?? 0),
        hasAdoptedZeroLineBill: Boolean(r.has_adopted_zero_line),
        billableOrderedQty: Number(r.billable_ordered_qty ?? 0),
      },
    ])
  );

  for (const row of rows) {
    const enr = byId.get(row.id);
    out.set(
      row.id,
      deriveBilledStatus({
        billedQty: enr?.billedQty ?? 0,
        hasAdoptedZeroLineBill: enr?.hasAdoptedZeroLineBill ?? false,
        billableOrderedQty: enr?.billableOrderedQty ?? 0,
      })
    );
  }
  return out;
}
