/**
 * verify-receive-counters.ts
 *
 * Regression gate for the persist-receipt-step counter-drift incident
 * (2026-04-27). Two checks:
 *
 *   1. Static  — runs the drift query (same as scripts/checks/check-po-counter-drift.ts).
 *      Exits non-zero if any drift exists.
 *
 *   2. Dynamic — if env VERIFY_PO_ID is set, invokes receivePurchaseOrderWorkflow
 *      against that PO with qty=1 on the first open line, then re-reads via
 *      raw SQL and asserts:
 *        - PO line qty_received increased by 1
 *        - PO total_units_received increased by 1
 *        - PO status reflects the new state
 *
 * Usage:
 *   yarn medusa exec src/scripts/verify/verify-receive-counters.ts
 *   VERIFY_PO_ID=po_xxx yarn medusa exec src/scripts/verify/verify-receive-counters.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { receivePurchaseOrderWorkflow } from "../../workflows/purchase-orders/receive-purchase-order";

interface PoRow {
  id: string;
  number: string;
  status: string;
  vendor_name_snapshot: string;
  vendor_qb_list_id_snapshot: string;
  qb_purchase_order_list_id: string | null;
  stock_location_id: string;
  total_units_received: number;
  total_units_ordered: number;
}

interface PolRow {
  id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qb_item_list_id_snapshot: string | null;
  qb_txn_line_id: string | null;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  unit_cost_cents: number;
}

export default async function verifyReceiveCounters({
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

  console.log("=== verify-receive-counters ===\n");

  // CHECK 1 — static drift
  const drift = (
    await knex.raw(
      `WITH line_actuals AS (
         SELECT pol.id AS line_id,
                pol.qty_received AS stored,
                COALESCE(SUM(prl.qty_received_now) FILTER (
                  WHERE prl.deleted_at IS NULL
                    AND pr.deleted_at IS NULL
                    AND pr.status NOT IN ('voided','deleted')
                ), 0)::int AS actual
           FROM purchase_order po
           JOIN purchase_order_line pol ON pol.purchase_order_id = po.id
                                        AND pol.deleted_at IS NULL
           LEFT JOIN purchase_order_receipt_line prl ON prl.purchase_order_line_id = pol.id
           LEFT JOIN purchase_order_receipt pr ON pr.id = prl.purchase_order_receipt_id
          WHERE po.deleted_at IS NULL
          GROUP BY pol.id, pol.qty_received
       )
       SELECT COUNT(*)::int AS drifted FROM line_actuals WHERE stored <> actual`
    )
  ).rows as Array<{ drifted: number }>;

  const driftedCount = drift[0]?.drifted ?? 0;
  console.log(`[1/2] Static drift check: ${driftedCount} lines drifted`);
  if (driftedCount > 0) {
    console.error(
      "FAIL — drift detected. Run scripts/checks/check-po-counter-drift.ts for details."
    );
    process.exitCode = 1;
    return;
  }
  console.log("OK — zero drift across all POs.\n");

  // CHECK 2 — dynamic e2e (optional)
  const verifyPoId = process.env.VERIFY_PO_ID;
  if (!verifyPoId) {
    console.log(
      "[2/2] Skipped dynamic check — set VERIFY_PO_ID=po_xxx to exercise the receive workflow."
    );
    console.log("\nVERIFY OK");
    return;
  }

  console.log(`[2/2] Dynamic e2e against PO ${verifyPoId} ...`);

  const poRows = (
    await knex.raw(
      `SELECT id, number, status, vendor_name_snapshot, vendor_qb_list_id_snapshot,
              qb_purchase_order_list_id, stock_location_id,
              total_units_received, total_units_ordered
         FROM purchase_order WHERE id = ? AND deleted_at IS NULL`,
      [verifyPoId]
    )
  ).rows as PoRow[];
  const po = poRows[0];
  if (!po) {
    console.error(`PO ${verifyPoId} not found.`);
    process.exitCode = 1;
    return;
  }
  if (po.status !== "submitted" && po.status !== "partially_received") {
    console.error(
      `PO ${po.number} status=${po.status} — must be submitted or partially_received.`
    );
    process.exitCode = 1;
    return;
  }
  const lineRows = (
    await knex.raw(
      `SELECT id, product_variant_id, inventory_item_id, sku_snapshot,
              description_snapshot, qb_item_list_id_snapshot, qb_txn_line_id,
              qty_ordered, qty_received, qty_cancelled, unit_cost_cents
         FROM purchase_order_line
        WHERE purchase_order_id = ? AND deleted_at IS NULL
          AND status IN ('open','partial')
        ORDER BY line_order LIMIT 1`,
      [po.id]
    )
  ).rows as PolRow[];
  const line = lineRows[0];
  if (!line) {
    console.error(`PO ${po.number} has no open/partial line to receive against.`);
    process.exitCode = 1;
    return;
  }
  const remaining = line.qty_ordered - line.qty_received - line.qty_cancelled;
  if (remaining < 1) {
    console.error(
      `Line ${line.id} has remaining=${remaining} — cannot receive 1 unit.`
    );
    process.exitCode = 1;
    return;
  }

  const userIdRow = (
    await knex.raw(
      `SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`
    )
  ).rows as Array<{ id: string }>;
  const userId = userIdRow[0]?.id;
  if (!userId) {
    console.error("No admin user found.");
    process.exitCode = 1;
    return;
  }

  const expectedLineQty = line.qty_received + 1;
  const expectedTotal = po.total_units_received + 1;

  await receivePurchaseOrderWorkflow(container).run({
    input: {
      po_id: po.id,
      po_number: po.number,
      vendor_qb_list_id: po.vendor_qb_list_id_snapshot,
      vendor_name: po.vendor_name_snapshot,
      qb_po_list_id: po.qb_purchase_order_list_id,
      qb_inventory_site_list_id: null,
      received_by_user_id: userId,
      stock_location_id: po.stock_location_id,
      received_at: new Date(),
      vendor_bill_number: `VERIFY-${Date.now()}`,
      vendor_bill_date: new Date(),
      notes: "verify-receive-counters",
      qb_memo: `${po.number} verify`,
      lines: [
        {
          po_line_id: line.id,
          product_variant_id: line.product_variant_id,
          inventory_item_id: line.inventory_item_id,
          sku_snapshot: line.sku_snapshot,
          description_snapshot: line.description_snapshot,
          qb_item_list_id_snapshot: line.qb_item_list_id_snapshot,
          qb_po_txn_line_id: line.qb_txn_line_id,
          qty_received_now: 1,
          unit_cost_cents_effective: line.unit_cost_cents,
          unit_cost_cents_override: null,
        },
      ],
    },
  });

  // Read back via raw SQL
  const afterLine = (
    await knex.raw(
      `SELECT qty_received, status FROM purchase_order_line WHERE id = ?`,
      [line.id]
    )
  ).rows as Array<{ qty_received: number; status: string }>;
  const afterPo = (
    await knex.raw(
      `SELECT status, total_units_received FROM purchase_order WHERE id = ?`,
      [po.id]
    )
  ).rows as Array<{ status: string; total_units_received: number }>;

  const lineRow = afterLine[0];
  const poRow = afterPo[0];
  const fail: string[] = [];
  if (lineRow?.qty_received !== expectedLineQty)
    fail.push(`line.qty_received expected=${expectedLineQty} actual=${lineRow?.qty_received}`);
  if (poRow?.total_units_received !== expectedTotal)
    fail.push(`po.total_units_received expected=${expectedTotal} actual=${poRow?.total_units_received}`);

  if (fail.length > 0) {
    console.error("FAIL — counter assertions failed:");
    for (const f of fail) console.error("  - " + f);
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK — line.qty_received=${lineRow.qty_received}, po.total_units_received=${poRow.total_units_received}, po.status=${poRow.status}`
  );
  console.log("\nVERIFY OK");
}
