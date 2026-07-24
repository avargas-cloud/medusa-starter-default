/**
 * src/api/admin/purchase-orders/_lib/billed-status.ts
 *
 * Derives whether a Purchase Order has been billed by the vendor, based on
 * its REGULAR vendor bills that are status IN ('confirmed', 'synced') and
 * not soft-deleted (drafts never count — nothing is committed yet).
 *
 * Rules (owner 2026-07-24):
 * - billed_qty = SUM of qualifying bills' product-line qty
 *   (vendor_bill_line, deleted_at IS NULL, line_type='product').
 * - An ADOPTED header-only bill (qb_source='adopted' with ZERO lines — a
 *   legacy import of the accountant's QB bill during reconciliation) counts
 *   as FULLY billing the PO: the reconciliation already classified it, and
 *   it has no lines by design.
 * - 'no'      — no qualifying bill exists.
 * - 'yes'     — an adopted zero-line bill exists, OR billed_qty covers the
 *               PO's total_units_received (when > 0). Billed-ahead-of-receive
 *               (received=0, a qualifying bill exists) is also 'yes' — the
 *               vendor's invoicing timing is their call, not ours to flag.
 * - 'partial' — bills exist but cover less than what was received (e.g. the
 *               vendor invoiced a partial shipment).
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
  totalUnitsReceived: number;
}): BilledInfo {
  const { billedQty, hasAdoptedZeroLineBill, totalUnitsReceived } = args;

  if (billedQty <= 0 && !hasAdoptedZeroLineBill) {
    return { billed_status: "no", billed_qty: billedQty };
  }
  if (hasAdoptedZeroLineBill || (totalUnitsReceived > 0 && billedQty >= totalUnitsReceived)) {
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
  rows: Array<{ id: string; total_units_received?: number | null }>
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
     )
     SELECT po_id,
            COALESCE(SUM(line_qty), 0) AS billed_qty,
            BOOL_OR(line_count = 0 AND qb_source = 'adopted') AS has_adopted_zero_line
       FROM bill_totals
      GROUP BY po_id`,
    [ids]
  )) as {
    rows: Array<{ po_id: string; billed_qty: string | number; has_adopted_zero_line: boolean }>;
  };

  const byId = new Map(
    result.rows.map((r) => [
      r.po_id,
      { billedQty: Number(r.billed_qty ?? 0), hasAdoptedZeroLineBill: Boolean(r.has_adopted_zero_line) },
    ])
  );

  for (const row of rows) {
    const enr = byId.get(row.id);
    out.set(
      row.id,
      deriveBilledStatus({
        billedQty: enr?.billedQty ?? 0,
        hasAdoptedZeroLineBill: enr?.hasAdoptedZeroLineBill ?? false,
        totalUnitsReceived: Number(row.total_units_received ?? 0),
      })
    );
  }
  return out;
}
