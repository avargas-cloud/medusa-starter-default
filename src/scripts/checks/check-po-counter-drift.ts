/**
 * check-po-counter-drift.ts
 *
 * Read-only diagnostic. Compares denormalized counters on purchase_order /
 * purchase_order_line against the authoritative SUM over non-voided/non-deleted
 * receipt lines.
 *
 * Reports:
 *   - Lines where qty_received != SUM(receipt_lines)
 *   - POs where total_units_received != SUM(line.qty_received)
 *   - POs where status doesn't match the implied state
 *
 * Usage (from backend/):
 *   yarn medusa exec src/scripts/checks/check-po-counter-drift.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

interface LineDriftRow {
  po_id: string;
  po_number: string | null;
  po_status: string;
  line_id: string;
  sku: string;
  qty_ordered: number;
  qty_received_stored: number;
  qty_received_actual: number;
  drift: number;
}

interface HeaderDriftRow {
  po_id: string;
  po_number: string | null;
  po_status: string;
  total_units_received_stored: number;
  total_units_received_actual: number;
  total_units_ordered: number;
  drift: number;
  implied_status: string;
}

export default async function checkPoCounterDrift({
  container,
}: {
  container: MedusaContainer;
}) {
  const knex = (
    container as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }
  ).resolve("__pg_connection__");

  console.log("=== check-po-counter-drift ===\n");

  const lineDrift = (
    await knex.raw(
      `SELECT po.id           AS po_id,
              po.number       AS po_number,
              po.status       AS po_status,
              pol.id          AS line_id,
              pol.sku_snapshot AS sku,
              pol.qty_ordered,
              pol.qty_received AS qty_received_stored,
              COALESCE(SUM(prl.qty_received_now) FILTER (
                WHERE prl.deleted_at IS NULL
                  AND pr.deleted_at IS NULL
                  AND pr.status NOT IN ('voided','deleted')
              ), 0)::int AS qty_received_actual
         FROM purchase_order po
         JOIN purchase_order_line pol ON pol.purchase_order_id = po.id
                                      AND pol.deleted_at IS NULL
         LEFT JOIN purchase_order_receipt_line prl ON prl.purchase_order_line_id = pol.id
         LEFT JOIN purchase_order_receipt pr ON pr.id = prl.purchase_order_receipt_id
        WHERE po.deleted_at IS NULL
        GROUP BY po.id, po.number, po.status, pol.id, pol.sku_snapshot,
                 pol.qty_ordered, pol.qty_received
        HAVING pol.qty_received <> COALESCE(SUM(prl.qty_received_now) FILTER (
                 WHERE prl.deleted_at IS NULL
                   AND pr.deleted_at IS NULL
                   AND pr.status NOT IN ('voided','deleted')
               ), 0)
        ORDER BY po.created_at DESC`
    )
  ).rows as LineDriftRow[];

  console.log(`Lines with drift: ${lineDrift.length}`);
  for (const r of lineDrift) {
    console.log(
      `  PO ${r.po_number ?? r.po_id} [${r.po_status}] line=${r.line_id} sku=${r.sku} ordered=${r.qty_ordered} stored=${r.qty_received_stored} actual=${r.qty_received_actual} drift=${r.qty_received_actual - r.qty_received_stored}`
    );
  }

  const headerDrift = (
    await knex.raw(
      `WITH line_actuals AS (
         SELECT pol.purchase_order_id AS po_id,
                COALESCE(SUM(
                  COALESCE(prl_sum.actual, 0)
                ), 0)::int AS total_actual,
                SUM(pol.qty_ordered)::int AS total_ordered
           FROM purchase_order_line pol
           LEFT JOIN LATERAL (
             SELECT SUM(prl.qty_received_now)::int AS actual
               FROM purchase_order_receipt_line prl
               JOIN purchase_order_receipt pr ON pr.id = prl.purchase_order_receipt_id
              WHERE prl.purchase_order_line_id = pol.id
                AND prl.deleted_at IS NULL
                AND pr.deleted_at IS NULL
                AND pr.status NOT IN ('voided','deleted')
           ) prl_sum ON true
          WHERE pol.deleted_at IS NULL
          GROUP BY pol.purchase_order_id
       )
       SELECT po.id           AS po_id,
              po.number       AS po_number,
              po.status       AS po_status,
              po.total_units_received AS total_units_received_stored,
              la.total_actual         AS total_units_received_actual,
              la.total_ordered        AS total_units_ordered,
              CASE
                WHEN la.total_actual = 0 THEN 'submitted'
                WHEN la.total_actual >= la.total_ordered THEN 'received'
                ELSE 'partially_received'
              END AS implied_status
         FROM purchase_order po
         JOIN line_actuals la ON la.po_id = po.id
        WHERE po.deleted_at IS NULL
          AND po.status NOT IN ('draft','voided','cancelled','closed')
          AND (
            po.total_units_received <> la.total_actual
            OR (
              po.status IN ('submitted','partially_received','received')
              AND po.status <> CASE
                WHEN la.total_actual = 0 THEN 'submitted'
                WHEN la.total_actual >= la.total_ordered THEN 'received'
                ELSE 'partially_received'
              END
            )
          )
        ORDER BY po.created_at DESC`
    )
  ).rows as HeaderDriftRow[];

  console.log(`\nHeaders with drift: ${headerDrift.length}`);
  for (const r of headerDrift) {
    console.log(
      `  PO ${r.po_number ?? r.po_id} status=${r.po_status} (implied=${r.implied_status}) tur stored=${r.total_units_received_stored} actual=${r.total_units_received_actual} ordered=${r.total_units_ordered}`
    );
  }

  console.log("\n=== summary ===");
  console.log(`Lines drifted:   ${lineDrift.length}`);
  console.log(`Headers drifted: ${headerDrift.length}`);
  if (lineDrift.length === 0 && headerDrift.length === 0) {
    console.log("OK — no drift detected.");
  } else {
    console.log(
      "Run scripts/fix/fix-po-receive-counter-drift.ts to repair (defaults to --dry-run)."
    );
  }
}
