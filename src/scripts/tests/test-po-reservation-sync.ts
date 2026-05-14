/**
 * src/scripts/tests/test-po-reservation-sync.ts
 *
 * Verifies that reducing or deleting PO lines also reduces / releases the
 * matching China reservations through `rebuildTransferChinaReservations`.
 *
 * Mirrors the side-effect branch in `backend/src/api/admin/purchase-orders/[id]/route.ts`
 * lines 628-676 (lookup linked transfer, soft-delete or update transfer_line,
 * then rebuild reservation_item rows).
 *
 * Run: npx medusa exec ./src/scripts/tests/test-po-reservation-sync.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../modules/purchase-orders/service";
import { rebuildTransferChinaReservations } from "../../lib/inventory-transfer-reservations";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

// Two real variants with inventory_levels at China (taken from the sandbox).
const FIXTURE = {
  variantA: {
    variant_id: "variant_8-feet-aluminum-channel-silver-as1_default",
    inventory_item_id: "iitem_01KFS1H9JZSEN2YF3MK0MYBWPG",
    sku: "EAP-AS1-8S",
  },
  variantB: {
    variant_id: "variant_8-feet-aluminum-channel-black_default",
    inventory_item_id: "iitem_01KFS1H8XT1WZN2JWNQ9NQBRPF",
    sku: "EAP-AS1-8B",
  },
};

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
};

let results: { name: string; ok: boolean; note?: string }[] = [];
function record(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
}

async function getChinaReserved(
  knex: Knex,
  inventoryItemId: string
): Promise<number> {
  const r = await knex.raw(
    `SELECT reserved_quantity::int AS rq FROM inventory_level
       WHERE inventory_item_id = ? AND location_id = ? AND deleted_at IS NULL`,
    [inventoryItemId, CHINA_LOC]
  );
  return Number(r.rows[0]?.rq ?? 0);
}

async function countActiveReservations(
  knex: Knex,
  transferId: string
): Promise<number> {
  const r = await knex.raw(
    `SELECT COUNT(*)::int AS c FROM reservation_item
       WHERE metadata->>'inventory_transfer_id' = ?
         AND deleted_at IS NULL`,
    [transferId]
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function getReservationQty(
  knex: Knex,
  transferLineId: string
): Promise<number | null> {
  const r = await knex.raw(
    `SELECT quantity::int AS q FROM reservation_item
       WHERE external_id = ? AND deleted_at IS NULL`,
    [`inventory-transfer:${transferLineId}`]
  );
  return r.rows[0]?.q != null ? Number(r.rows[0].q) : null;
}

function ulid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export default async function test({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const poService = container.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;
  const knex = container.resolve("__pg_connection__") as Knex;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  PO PATCH → China reservation sync");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  let poId: string | null = null;
  let transferId: string | null = null;
  const transferLineIds: { A: string; B: string } = { A: "", B: "" };

  const baselineA = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
  const baselineB = await getChinaReserved(knex, FIXTURE.variantB.inventory_item_id);
  console.log(
    `\nBaseline China reserved — A:${baselineA}  B:${baselineB}`
  );

  try {
    // ── Fixture setup ─────────────────────────────────────────────────────
    const [po] = await poService.createPurchaseOrders([
      {
        status: "submitted",
        vendor_id: "qbv_smoke_test",
        stock_location_id: "sloc_01KFS2AV3TAKR141KC2D6JCGTR",
        ordered_at: new Date(),
        memo: "Reservation sync test",
        reference_number: "RSV-TEST",
        subtotal_cents: 0,
        tax_cents: 0,
        shipping_cents: 0,
        other_fees_cents: 0,
        total_cents: 0,
        total_lines: 2,
        total_units_ordered: 80,
        created_by_user_id: "user_rsv_test",
      },
    ]);
    poId = po.id as string;

    const lines = await poService.createPurchaseOrderLines([
      {
        purchase_order_id: poId,
        product_variant_id: FIXTURE.variantA.variant_id,
        inventory_item_id: FIXTURE.variantA.inventory_item_id,
        sku_snapshot: FIXTURE.variantA.sku,
        description_snapshot: "Variant A",
        qty_ordered: 50,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 5000,
        status: "open",
        line_order: 0,
      },
      {
        purchase_order_id: poId,
        product_variant_id: FIXTURE.variantB.variant_id,
        inventory_item_id: FIXTURE.variantB.inventory_item_id,
        sku_snapshot: FIXTURE.variantB.sku,
        description_snapshot: "Variant B",
        qty_ordered: 30,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 3000,
        status: "open",
        line_order: 1,
      },
    ]);

    transferId = ulid("it_rsv_test");
    await knex.raw(
      `INSERT INTO inventory_transfer
         (id, status, origin_country, destination_location_id, linked_purchase_order_id, total_lines, total_units, subtotal_cents, created_by_user_id, created_at, updated_at)
         VALUES (?, 'draft', 'CN', ?, ?, 2, 80, 8000, 'user_rsv_test', NOW(), NOW())`,
      [
        transferId,
        "sloc_01KFS2AV3TAKR141KC2D6JCGTR",
        poId,
      ]
    );

    transferLineIds.A = ulid("itl_rsv_test_A");
    transferLineIds.B = ulid("itl_rsv_test_B");
    await knex.raw(
      `INSERT INTO inventory_transfer_line
         (id, transfer_id, product_variant_id, sku, qty, qty_received, unit_cost_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, 50, 0, 100, NOW(), NOW()),
              (?, ?, ?, ?, 30, 0, 100, NOW(), NOW())`,
      [
        transferLineIds.A,
        transferId,
        FIXTURE.variantA.variant_id,
        FIXTURE.variantA.sku,
        transferLineIds.B,
        transferId,
        FIXTURE.variantB.variant_id,
        FIXTURE.variantB.sku,
      ]
    );

    record(
      "Fixture: PO + transfer + 2 transfer lines created",
      true,
      `poId=${poId} transferId=${transferId}`
    );

    // ── Initial reservation build ────────────────────────────────────────
    await rebuildTransferChinaReservations(knex, transferId, poId);

    const afterBuildA = await getReservationQty(knex, transferLineIds.A);
    const afterBuildB = await getReservationQty(knex, transferLineIds.B);
    const reservedA1 = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
    const reservedB1 = await getChinaReserved(knex, FIXTURE.variantB.inventory_item_id);

    record(
      "Initial rebuild: reservation A.qty=50, B.qty=30",
      afterBuildA === 50 && afterBuildB === 30,
      `A=${afterBuildA}, B=${afterBuildB}`
    );
    record(
      "inventory_level.reserved_quantity bumped +50 (A) and +30 (B)",
      reservedA1 === baselineA + 50 && reservedB1 === baselineB + 30,
      `A: ${baselineA}→${reservedA1}, B: ${baselineB}→${reservedB1}`
    );

    // ── Case: REDUCE qty_ordered 50→20 on line A ─────────────────────────
    const lineAId = (lines as Array<{ id: string }>)[0].id;
    await poService.updatePurchaseOrderLines([{ id: lineAId, qty_ordered: 20 }]);
    await knex.raw(
      `UPDATE inventory_transfer_line SET qty=20, updated_at=NOW()
         WHERE id=? AND deleted_at IS NULL`,
      [transferLineIds.A]
    );
    await rebuildTransferChinaReservations(knex, transferId, poId);

    const afterReduceA = await getReservationQty(knex, transferLineIds.A);
    const afterReduceB = await getReservationQty(knex, transferLineIds.B);
    const reservedA2 = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
    const reservedB2 = await getChinaReserved(knex, FIXTURE.variantB.inventory_item_id);

    record(
      "After reducing line A 50→20: reservation A.qty=20",
      afterReduceA === 20,
      `A=${afterReduceA}`
    );
    record(
      "Line B reservation untouched (still 30)",
      afterReduceB === 30,
      `B=${afterReduceB}`
    );
    record(
      "inventory_level.reserved_quantity for A: baseline+50→baseline+20",
      reservedA2 === baselineA + 20,
      `${baselineA}+50→${reservedA2}, expected ${baselineA + 20}`
    );
    record(
      "inventory_level.reserved_quantity for B unchanged (baseline+30)",
      reservedB2 === baselineB + 30,
      `B reserved=${reservedB2}, expected ${baselineB + 30}`
    );

    // ── Case: DELETE line B  ─────────────────────────────────────────────
    const lineBId = (lines as Array<{ id: string }>)[1].id;
    await poService.deletePurchaseOrderLines([lineBId]);
    await knex.raw(
      `UPDATE inventory_transfer_line SET deleted_at=NOW(), updated_at=NOW()
         WHERE id=? AND deleted_at IS NULL`,
      [transferLineIds.B]
    );
    await rebuildTransferChinaReservations(knex, transferId, poId);

    const afterDeleteB = await getReservationQty(knex, transferLineIds.B);
    const reservedA3 = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
    const reservedB3 = await getChinaReserved(knex, FIXTURE.variantB.inventory_item_id);
    const activeCount = await countActiveReservations(knex, transferId);

    record(
      "After deleting line B: reservation B is gone",
      afterDeleteB === null,
      `B reservation = ${afterDeleteB}`
    );
    record(
      "inventory_level.reserved_quantity for B back to baseline",
      reservedB3 === baselineB,
      `B reserved=${reservedB3}, expected ${baselineB}`
    );
    record(
      "Line A reservation still intact (qty=20)",
      reservedA3 === baselineA + 20,
      `A reserved=${reservedA3}, expected ${baselineA + 20}`
    );
    record(
      "Only 1 active reservation remains for the transfer",
      activeCount === 1,
      `active=${activeCount}`
    );

    // ── Case: REDUCE line A to 0 (user picks qty=0 from the new UI) ──────
    await poService.updatePurchaseOrderLines([{ id: lineAId, qty_ordered: 0 }]);
    await knex.raw(
      `UPDATE inventory_transfer_line SET qty=0, updated_at=NOW()
         WHERE id=? AND deleted_at IS NULL`,
      [transferLineIds.A]
    );
    await rebuildTransferChinaReservations(knex, transferId, poId);

    const afterZeroA = await getReservationQty(knex, transferLineIds.A);
    const reservedA4 = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
    const activeCountFinal = await countActiveReservations(knex, transferId);

    record(
      "qty_ordered=0 → reservation A released (no active row)",
      afterZeroA === null,
      `A reservation = ${afterZeroA}`
    );
    record(
      "inventory_level.reserved_quantity for A back to baseline",
      reservedA4 === baselineA,
      `A reserved=${reservedA4}, expected ${baselineA}`
    );
    record(
      "Zero active reservations on the transfer",
      activeCountFinal === 0,
      `active=${activeCountFinal}`
    );
  } catch (err) {
    record("Setup/execution", false, String((err as Error).message));
    console.error(err);
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    if (transferId) {
      await knex.raw(
        `DELETE FROM reservation_item WHERE metadata->>'inventory_transfer_id' = ?`,
        [transferId]
      );
      await knex.raw(
        `DELETE FROM inventory_transfer_line WHERE transfer_id = ?`,
        [transferId]
      );
      await knex.raw(`DELETE FROM inventory_transfer WHERE id = ?`, [transferId]);
    }
    if (poId) {
      const dbLines = (await poService.listPurchaseOrderLines(
        { purchase_order_id: poId },
        { take: 100, skip: 0 }
      )) as Array<{ id: string }>;
      if (dbLines.length > 0) {
        await poService.deletePurchaseOrderLines(dbLines.map((l) => l.id));
      }
      await poService.deletePurchaseOrders([poId]);
    }

    // Verify cleanup restored China reserved to baseline
    const finalA = await getChinaReserved(knex, FIXTURE.variantA.inventory_item_id);
    const finalB = await getChinaReserved(knex, FIXTURE.variantB.inventory_item_id);
    console.log(
      `\n  [cleanup] China reserved final — A:${finalA} (baseline ${baselineA})  B:${finalB} (baseline ${baselineB})`
    );
    record(
      "Cleanup restored China reserved to baseline",
      finalA === baselineA && finalB === baselineB,
      `A: ${baselineA}→${finalA}, B: ${baselineB}→${finalB}`
    );
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${passed} passed / ${failed} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  if (failed > 0) {
    process.exitCode = 1;
    console.log("Failed cases:");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name}${r.note ? ` — ${r.note}` : ""}`));
  }
}
