/**
 * Cleanup orphaned reservation on backfilled transfer IT-1004 (it_po1013_transfer).
 *
 * The EPS-MDA-60-24 line was removed from PO-1013 (early-version bug) but the
 * backfilled transfer kept an orphan line (itl_1013_14, qty 5, qty_received 0)
 * with a live reservation of 5 units at China → China level: stocked 0,
 * reserved 5 → available −5 phantom, and the transfer stuck in "Shipped".
 *
 * Fix: release the orphan reservation (via inventory module → updates numeric +
 * raw_ + Meili), soft-delete the orphan line, fix header totals, mark the
 * transfer received (all real lines were already received). MUST run BEFORE the
 * China physical-count import so EPS-MDA-60-24 ends at stocked 25 (not 30).
 *
 * Dry-run:  env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/cleanup-it1004-orphan-reservation.ts
 * Apply:    APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/cleanup-it1004-orphan-reservation.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const TRANSFER_ID = "it_po1013_transfer";
const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}
interface InventoryLike {
  deleteReservationItems: (ids: string[]) => Promise<void>;
}

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;
  const inventoryService = container.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryLike;

  console.log(`\n🧹 IT-1004 orphan cleanup`);
  console.log(`Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (no changes)"}\n`);

  // Find orphan reservations on this transfer whose line SKU is no longer on the PO.
  const { rows: orphans } = await knex.raw(
    `SELECT ri.id AS reservation_id, ri.quantity, itl.id AS line_id, itl.sku,
            itl.qty, itl.qty_received
     FROM reservation_item ri
     JOIN inventory_transfer it ON it.id = ri.metadata->>'inventory_transfer_id'
     JOIN inventory_transfer_line itl ON itl.id = ri.metadata->>'inventory_transfer_line_id'
     WHERE ri.deleted_at IS NULL
       AND ri.metadata->>'inventory_transfer_id' = ?
       AND itl.qty_received = 0
       AND NOT EXISTS (
         SELECT 1 FROM purchase_order_line pol
         WHERE pol.purchase_order_id = it.linked_purchase_order_id
           AND pol.sku_snapshot = itl.sku AND pol.deleted_at IS NULL
       )`,
    [TRANSFER_ID]
  );
  const list = orphans as Array<{
    reservation_id: string;
    quantity: number;
    line_id: string;
    sku: string;
    qty: number;
    qty_received: number;
  }>;

  if (list.length === 0) {
    console.log("No orphan reservations found — already clean. Nothing to do.\n");
    return;
  }

  for (const o of list) {
    console.log(
      `  orphan: ${o.sku} · line ${o.line_id} (qty ${o.qty}, recv ${o.qty_received}) · reservation ${o.reservation_id} (${o.quantity} units)`
    );
  }

  // Show China level before
  const before = await knex.raw(
    `SELECT pv.sku, il.stocked_quantity, il.reserved_quantity
     FROM inventory_level il
     JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
     JOIN product_variant pv ON pv.id = pvii.variant_id
     WHERE pv.sku = ANY(?) AND il.location_id = ?`,
    [list.map((o) => o.sku), CHINA_LOC]
  );
  console.log(`\n  China levels BEFORE:`);
  for (const r of before.rows as Array<Record<string, unknown>>) {
    console.log(
      `    ${r.sku}: stocked ${r.stocked_quantity}, reserved ${r.reserved_quantity}`
    );
  }

  if (!apply) {
    console.log(
      `\n  Would: delete ${list.length} reservation(s), soft-delete ${list.length} line(s), recompute header totals, mark IT-1004 received.`
    );
    console.log(`\n✅ DRY-RUN complete. Re-run with APPLY=1 to execute.\n`);
    return;
  }

  // 1) Release reservations via the inventory module (numeric + raw_ + Meili)
  await inventoryService.deleteReservationItems(
    list.map((o) => o.reservation_id)
  );

  // 2) Soft-delete orphan lines
  await knex.raw(
    `UPDATE inventory_transfer_line SET deleted_at = now(), updated_at = now()
     WHERE id = ANY(?)`,
    [list.map((o) => o.line_id)]
  );

  // 3) Recompute header totals from live lines + mark received
  await knex.raw(
    `UPDATE inventory_transfer it SET
       total_lines = sub.cnt,
       total_units = sub.units,
       status = 'received',
       received_at = COALESCE(it.received_at, now()),
       updated_at = now()
     FROM (
       SELECT COUNT(*)::int AS cnt, COALESCE(SUM(qty),0)::int AS units
       FROM inventory_transfer_line
       WHERE transfer_id = ? AND deleted_at IS NULL
     ) sub
     WHERE it.id = ?`,
    [TRANSFER_ID, TRANSFER_ID]
  );

  const after = await knex.raw(
    `SELECT pv.sku, il.stocked_quantity, il.reserved_quantity, il.raw_reserved_quantity
     FROM inventory_level il
     JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
     JOIN product_variant pv ON pv.id = pvii.variant_id
     WHERE pv.sku = ANY(?) AND il.location_id = ?`,
    [list.map((o) => o.sku), CHINA_LOC]
  );
  console.log(`\n  China levels AFTER:`);
  for (const r of after.rows as Array<Record<string, unknown>>) {
    console.log(
      `    ${r.sku}: stocked ${r.stocked_quantity}, reserved ${r.reserved_quantity} (raw ${JSON.stringify(r.raw_reserved_quantity)})`
    );
  }

  const hdr = await knex.raw(
    `SELECT number, status, total_lines, total_units, received_at FROM inventory_transfer WHERE id = ?`,
    [TRANSFER_ID]
  );
  console.log(`\n  Transfer header AFTER: ${JSON.stringify((hdr.rows as unknown[])[0])}`);
  console.log(`\n✅ Cleanup applied.\n`);
}
