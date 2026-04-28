/**
 * repro-receive-counter-bug.ts
 *
 * Reproduces the silent-no-op bug in persistReceiptStep:
 *   1. Picks an existing submitted PO with vendor_qb_list_id set, OR fails fast.
 *   2. Picks one open line, computes a small qty to receive.
 *   3. Invokes receivePurchaseOrderWorkflow directly (bypasses HTTP).
 *   4. Reads back the persisted PO header + line counters from raw SQL
 *      (NOT through the service, so no MikroORM identity-map interference).
 *   5. Prints expected vs actual divergence.
 *
 * Usage (from backend/):
 *   yarn medusa exec src/scripts/debug/repro-receive-counter-bug.ts
 *
 * The DIAG console.info lines emitted by persist-receipt-step instrumentation
 * will appear interleaved in stdout — capture them to confirm whether the
 * service.update*() calls returned successfully but no row was written.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { receivePurchaseOrderWorkflow } from "../../workflows/purchase-orders/receive-purchase-order";

const QTY_TO_RECEIVE = 1;

interface PoRow {
  id: string;
  number: string;
  status: string;
  vendor_id: string;
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
  status: string;
}

export default async function reproReceiveCounterBug({
  container,
}: {
  container: MedusaContainer;
}) {
  const knex = (container as unknown as {
    resolve: (k: string) => { raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  }).resolve("__pg_connection__");

  console.log("=== repro-receive-counter-bug ===");

  const candidatePos = (
    await knex.raw(
      `SELECT id, number, status, vendor_id, vendor_name_snapshot,
              vendor_qb_list_id_snapshot, qb_purchase_order_list_id,
              stock_location_id, total_units_received, total_units_ordered
         FROM purchase_order
        WHERE deleted_at IS NULL
          AND status IN ('submitted','partially_received')
          AND vendor_qb_list_id_snapshot IS NOT NULL
          AND number IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 5`
    )
  ).rows as PoRow[];

  if (candidatePos.length === 0) {
    console.error("No submitted/partially_received PO available. Submit a fresh PO via the UI first.");
    return;
  }

  let chosen: { po: PoRow; line: PolRow } | null = null;
  for (const po of candidatePos) {
    const lines = (
      await knex.raw(
        `SELECT id, product_variant_id, inventory_item_id, sku_snapshot,
                description_snapshot, qb_item_list_id_snapshot, qb_txn_line_id,
                qty_ordered, qty_received, qty_cancelled, unit_cost_cents, status
           FROM purchase_order_line
          WHERE purchase_order_id = ?
            AND deleted_at IS NULL
            AND status IN ('open','partial')
          ORDER BY line_order
          LIMIT 1`,
        [po.id]
      )
    ).rows as PolRow[];
    if (lines.length === 0) continue;
    const ln = lines[0];
    if (!ln) continue;
    const remaining = ln.qty_ordered - ln.qty_received - ln.qty_cancelled;
    if (remaining < QTY_TO_RECEIVE) continue;
    chosen = { po, line: ln };
    break;
  }

  if (!chosen) {
    console.error("No PO with a receivable line ≥ qty=%d found.", QTY_TO_RECEIVE);
    return;
  }

  const { po, line } = chosen;
  console.log("Using PO=%s (status=%s tur=%d/%d)", po.number, po.status, po.total_units_received, po.total_units_ordered);
  console.log(
    "Using line=%s sku=%s qty_ordered=%d qty_received_BEFORE=%d status_BEFORE=%s",
    line.id, line.sku_snapshot, line.qty_ordered, line.qty_received, line.status
  );

  const userIdRow = (
    await knex.raw(`SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`)
  ).rows as Array<{ id: string }>;
  const userId = userIdRow[0]?.id;
  if (!userId) {
    console.error("No user found to attribute receipt.");
    return;
  }

  console.log("Invoking receivePurchaseOrderWorkflow with qty=%d ...", QTY_TO_RECEIVE);

  const { result } = await receivePurchaseOrderWorkflow(container).run({
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
      vendor_bill_number: `REPRO-${Date.now()}`,
      vendor_bill_date: new Date(),
      notes: "repro-receive-counter-bug",
      qb_memo: `${po.number} repro`,
      lines: [
        {
          po_line_id: line.id,
          product_variant_id: line.product_variant_id,
          inventory_item_id: line.inventory_item_id,
          sku_snapshot: line.sku_snapshot,
          description_snapshot: line.description_snapshot,
          qb_item_list_id_snapshot: line.qb_item_list_id_snapshot,
          qb_po_txn_line_id: line.qb_txn_line_id,
          qty_received_now: QTY_TO_RECEIVE,
          unit_cost_cents_effective: line.unit_cost_cents,
          unit_cost_cents_override: null,
        },
      ],
    },
  });

  console.log("Workflow returned: receipt=%s po_status_after=%s tur_after=%d/%d", result.receipt_number, result.po_status_after, result.total_units_received, result.total_units_ordered);

  // Read DB state via raw SQL — bypasses identity map cache
  const afterPo = (
    await knex.raw(
      `SELECT status, total_units_received, total_units_ordered, updated_at
         FROM purchase_order WHERE id = ?`,
      [po.id]
    )
  ).rows as Array<{ status: string; total_units_received: number; total_units_ordered: number; updated_at: string }>;
  const afterLine = (
    await knex.raw(
      `SELECT qty_received, status, updated_at
         FROM purchase_order_line WHERE id = ?`,
      [line.id]
    )
  ).rows as Array<{ qty_received: number; status: string; updated_at: string }>;

  const expectedLineQty = line.qty_received + QTY_TO_RECEIVE;
  const expectedTotalReceived = po.total_units_received + QTY_TO_RECEIVE;

  const lineRow = afterLine[0];
  const poRow = afterPo[0];

  console.log("\n=== POST-WORKFLOW DB STATE (via raw SQL) ===");
  console.log("po.status: actual=%s expected_one_of=%s", poRow?.status, "partially_received|received");
  console.log("po.total_units_received: actual=%d expected=%d", poRow?.total_units_received, expectedTotalReceived);
  console.log("po_line.qty_received: actual=%d expected=%d", lineRow?.qty_received, expectedLineQty);
  console.log("po_line.status: actual=%s", lineRow?.status);

  const drift =
    poRow?.total_units_received !== expectedTotalReceived ||
    lineRow?.qty_received !== expectedLineQty;

  if (drift) {
    console.error("\n*** BUG REPRODUCED *** persisted counters do not match workflow return.");
  } else {
    console.log("\nOK — counters persisted as expected. Bug not reproduced (or already fixed).");
  }
}
