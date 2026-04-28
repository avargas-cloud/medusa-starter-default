/**
 * fix-po-receive-counter-drift.ts
 *
 * Repairs denormalized counters on purchase_order_line and purchase_order
 * to match SUM(receipt_lines). Idempotent — rows already in sync are skipped.
 *
 * Usage (from backend/):
 *   yarn medusa exec src/scripts/fix/fix-po-receive-counter-drift.ts        # dry-run
 *   APPLY=1 yarn medusa exec src/scripts/fix/fix-po-receive-counter-drift.ts  # commit
 *
 * The script is intentionally noisy: it prints every row it would touch,
 * so the operator can scan before re-running with APPLY=1.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

interface LineDriftRow {
  po_id: string;
  po_number: string | null;
  line_id: string;
  sku: string;
  qty_ordered: number;
  qty_received_stored: number;
  qty_received_actual: number;
  current_status: string;
  implied_status: "open" | "partial" | "complete";
}

interface HeaderDriftRow {
  po_id: string;
  po_number: string | null;
  current_status: string;
  total_units_received_stored: number;
  total_units_received_actual: number;
  total_units_ordered: number;
  implied_status: "submitted" | "partially_received" | "received";
}

export default async function fixPoReceiveCounterDrift({
  container,
}: {
  container: MedusaContainer;
}) {
  const apply = process.env.APPLY === "1";
  const knex = (
    container as unknown as {
      resolve: (k: string) => {
        raw: (
          sql: string,
          b?: unknown[]
        ) => Promise<{ rows: unknown[]; rowCount?: number }>;
      };
    }
  ).resolve("__pg_connection__");

  console.log(
    `=== fix-po-receive-counter-drift (mode=${apply ? "APPLY" : "DRY-RUN"}) ===\n`
  );

  const lineDrift = (
    await knex.raw(
      `SELECT po.id           AS po_id,
              po.number       AS po_number,
              pol.id          AS line_id,
              pol.sku_snapshot AS sku,
              pol.qty_ordered,
              pol.qty_received AS qty_received_stored,
              pol.status       AS current_status,
              COALESCE(SUM(prl.qty_received_now) FILTER (
                WHERE prl.deleted_at IS NULL
                  AND pr.deleted_at IS NULL
                  AND pr.status NOT IN ('voided','deleted')
              ), 0)::int AS qty_received_actual,
              CASE
                WHEN COALESCE(SUM(prl.qty_received_now) FILTER (
                  WHERE prl.deleted_at IS NULL
                    AND pr.deleted_at IS NULL
                    AND pr.status NOT IN ('voided','deleted')
                ), 0) = 0 THEN 'open'
                WHEN COALESCE(SUM(prl.qty_received_now) FILTER (
                  WHERE prl.deleted_at IS NULL
                    AND pr.deleted_at IS NULL
                    AND pr.status NOT IN ('voided','deleted')
                ), 0) >= pol.qty_ordered THEN 'complete'
                ELSE 'partial'
              END AS implied_status
         FROM purchase_order po
         JOIN purchase_order_line pol ON pol.purchase_order_id = po.id
                                      AND pol.deleted_at IS NULL
         LEFT JOIN purchase_order_receipt_line prl ON prl.purchase_order_line_id = pol.id
         LEFT JOIN purchase_order_receipt pr ON pr.id = prl.purchase_order_receipt_id
        WHERE po.deleted_at IS NULL
          AND pol.status <> 'cancelled'
        GROUP BY po.id, po.number, pol.id, pol.sku_snapshot,
                 pol.qty_ordered, pol.qty_received, pol.status
        HAVING pol.qty_received <> COALESCE(SUM(prl.qty_received_now) FILTER (
                 WHERE prl.deleted_at IS NULL
                   AND pr.deleted_at IS NULL
                   AND pr.status NOT IN ('voided','deleted')
               ), 0)
        ORDER BY po.created_at DESC`
    )
  ).rows as LineDriftRow[];

  console.log(`Lines to fix: ${lineDrift.length}`);
  let lineUpdates = 0;
  for (const r of lineDrift) {
    console.log(
      `  PO ${r.po_number ?? r.po_id} line=${r.line_id} sku=${r.sku} ${r.qty_received_stored}->${r.qty_received_actual} status:${r.current_status}->${r.implied_status}`
    );
    if (apply) {
      const upd = await knex.raw(
        `UPDATE purchase_order_line
            SET qty_received = ?, status = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [r.qty_received_actual, r.implied_status, r.line_id]
      );
      if (upd.rowCount === 1) lineUpdates += 1;
    }
  }

  const headerDrift = (
    await knex.raw(
      `WITH line_actuals AS (
         SELECT pol.purchase_order_id AS po_id,
                COALESCE(SUM(COALESCE(prl_sum.actual, 0)), 0)::int AS total_actual,
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
              po.status       AS current_status,
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
            OR po.status <> CASE
              WHEN la.total_actual = 0 THEN 'submitted'
              WHEN la.total_actual >= la.total_ordered THEN 'received'
              ELSE 'partially_received'
            END
          )
        ORDER BY po.created_at DESC`
    )
  ).rows as HeaderDriftRow[];

  console.log(`\nHeaders to fix: ${headerDrift.length}`);
  let headerUpdates = 0;
  for (const r of headerDrift) {
    console.log(
      `  PO ${r.po_number ?? r.po_id} tur:${r.total_units_received_stored}->${r.total_units_received_actual} status:${r.current_status}->${r.implied_status}`
    );
    if (apply) {
      const upd = await knex.raw(
        `UPDATE purchase_order
            SET status = ?, total_units_received = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [r.implied_status, r.total_units_received_actual, r.po_id]
      );
      if (upd.rowCount === 1) headerUpdates += 1;
    }
  }

  console.log("\n=== summary ===");
  console.log(`Lines:   ${lineDrift.length} drifted, ${lineUpdates} updated`);
  console.log(`Headers: ${headerDrift.length} drifted, ${headerUpdates} updated`);
  if (!apply) {
    console.log("\nDRY-RUN — re-run with APPLY=1 to commit.");
  }
}
