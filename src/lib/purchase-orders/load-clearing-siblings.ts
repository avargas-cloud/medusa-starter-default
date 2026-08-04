/**
 * load-clearing-siblings.ts
 *
 * The ONE query that answers "which bills has this regular bill's landed cost
 * already absorbed, and what are they worth right now".
 *
 * It has two callers who must not disagree: the Add, which BUILDS the negative
 * clearing lines from this answer, and the bill detail route, which compares
 * the same answer against what QuickBooks is holding to decide whether to warn.
 * If the warning read the siblings differently from the sender, the banner
 * would fire on bills that are fine — or stay quiet on bills that are not.
 *
 * `total_cents` is the sibling's CURRENT total, deliberately: the POS is the
 * truth, so a rebuild clears what the sibling is worth today, never the figure
 * QuickBooks was handed in July.
 */

import type { ClearingSibling } from "./qb-vendor-bill-clearing-lines";

export interface ClearingSiblingKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

const SIBLINGS_SQL = `
  SELECT sib.id AS vendor_bill_id, sib.number, sib.bill_type,
         (SELECT l.qb_account_list_id FROM vendor_bill_line l
           WHERE l.vendor_bill_id = sib.id AND l.deleted_at IS NULL
             AND COALESCE(l.line_type,'product') = 'qb_account'
           ORDER BY l.created_at LIMIT 1)        AS qb_account_list_id,
         (SELECT l.qb_account_full_name FROM vendor_bill_line l
           WHERE l.vendor_bill_id = sib.id AND l.deleted_at IS NULL
             AND COALESCE(l.line_type,'product') = 'qb_account'
           ORDER BY l.created_at LIMIT 1)        AS qb_account_full_name,
         COALESCE((SELECT SUM(l.qty * l.unit_cost_cents)::int
                     FROM vendor_bill_line l
                    WHERE l.vendor_bill_id = sib.id
                      AND l.deleted_at IS NULL), 0) AS total_cents
    FROM vendor_bill reg
    JOIN vendor_bill sib
      ON sib.id IN (reg.service_vendor_bill_id, reg.freight_vendor_bill_id,
                    reg.tariff_vendor_bill_id)
     AND sib.deleted_at IS NULL
   WHERE reg.id = ?
   ORDER BY sib.number`;

/**
 * A deleted sibling is excluded, which is the point: its pointer stays on the
 * regular bill (plain column, no FK, no cascade), and clearing against a bill
 * that no longer exists would remove money from A/P with nothing behind it.
 * The drift check sees that as a clearing line whose sibling is gone.
 */
export async function loadClearingSiblings(
  knex: ClearingSiblingKnex,
  regularBillId: string
): Promise<ClearingSibling[]> {
  const result = await knex.raw(SIBLINGS_SQL, [regularBillId]);
  return (result.rows as ClearingSibling[]).map((row) => ({
    ...row,
    total_cents: Number(row.total_cents ?? 0),
  }));
}
