/**
 * src/scripts/tests/test-po-line-edit-guards.ts
 *
 * Test the 6 cases for PO line edit guards introduced in the
 * 2026-05-14 frontend+backend pair (allow editing fully-received lines,
 * qty_ordered may go to 0, delete blocked when received > 0).
 *
 * 1. Validator accepts qty_ordered = 0
 * 2. Validator rejects qty_ordered = -1
 * 3. Validator accepts qty_ordered = 5 (sanity)
 * 4. PATCH guard: reduce qty_ordered 10→5 when qty_received=5  ⇒ allowed
 * 5. PATCH guard: reduce qty_ordered 10→4 when qty_received=5  ⇒ "line_locked"
 * 6. PATCH guard: bump qty_ordered on a fully-received line     ⇒ allowed
 * 7. PATCH guard: delete a line with qty_received=0             ⇒ allowed
 * 8. PATCH guard: delete a line with qty_received>0             ⇒ "line_locked"
 * 9. PATCH guard: qty_ordered = 0 when qty_received = 0         ⇒ allowed
 *
 * Run: npx medusa exec ./src/scripts/tests/test-po-line-edit-guards.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../modules/purchase-orders/service";
import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../modules/quickbooks-catalog/service";
import { updateDraftSchema as poUpdateDraftSchema } from "../../api/admin/purchase-orders/_lib/validators";
import { updateDraftSchema as foUpdateDraftSchema } from "../../api/admin/factory-orders/_lib/validators";

type LineFixture = {
  id: string;
  sku_snapshot: string;
  qty_ordered: number;
  qty_received: number;
};

// Mirrors the per-item guard at backend/src/api/admin/purchase-orders/[id]/route.ts.
function runPerItemGuard(
  oldLines: LineFixture[],
  toUpdate: Array<{ id: string; qty_ordered: number }>,
  toDeleteIds: string[]
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const toDeleteLines = oldLines.filter((l) => toDeleteIds.includes(l.id));
  for (const dl of toDeleteLines) {
    const qtyRecv = Number(dl.qty_received ?? 0);
    if (qtyRecv > 0) {
      errors.push(
        `"${dl.sku_snapshot}" has ${qtyRecv} received unit(s) and cannot be deleted.`
      );
    }
  }
  for (const u of toUpdate) {
    const old = oldLines.find((ol) => ol.id === u.id);
    if (!old) continue;
    const qtyRecv = Number(old.qty_received ?? 0);
    const sku = old.sku_snapshot;
    if (u.qty_ordered < qtyRecv) {
      errors.push(
        `"${sku}": qty_ordered cannot go below qty_received (${qtyRecv}).`
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

let results: { name: string; ok: boolean; note?: string }[] = [];

function record(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
}

export default async function test({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const poService = container.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;
  const qbService = container.resolve(
    QUICKBOOKS_CATALOG_MODULE
  ) as unknown as QuickbooksCatalogModuleService;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  PO line edit guards — sandbox test");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── Block A: Zod validator (PO + FO) ────────────────────────────────────
  console.log("\n▌ Block A — Zod validator for qty_ordered\n");

  const validatorFixtureLine = {
    product_variant_id: "variant_test_dummy",
    inventory_item_id: "iitem_test_dummy",
    sku_snapshot: "TEST-SKU",
    description_snapshot: "Test description",
    unit_cost_cents: 1000,
    tax_cents: 0,
  };

  // 1. qty_ordered = 0 should pass (PO)
  const po0 = poUpdateDraftSchema.safeParse({
    lines: [{ ...validatorFixtureLine, qty_ordered: 0 }],
  });
  record("[PO validator] qty_ordered=0 accepted", po0.success);

  // 1b. qty_ordered = 0 should pass (FO)
  const fo0 = foUpdateDraftSchema.safeParse({
    lines: [{ ...validatorFixtureLine, qty_ordered: 0 }],
  });
  record("[FO validator] qty_ordered=0 accepted", fo0.success);

  // 2. qty_ordered = -1 should be rejected (PO)
  const poNeg = poUpdateDraftSchema.safeParse({
    lines: [{ ...validatorFixtureLine, qty_ordered: -1 }],
  });
  record("[PO validator] qty_ordered=-1 rejected", !poNeg.success);

  // 3. qty_ordered = 5 sanity (PO)
  const po5 = poUpdateDraftSchema.safeParse({
    lines: [{ ...validatorFixtureLine, qty_ordered: 5 }],
  });
  record("[PO validator] qty_ordered=5 accepted (sanity)", po5.success);

  // ── Block B: Per-item guard (PATCH route logic) ─────────────────────────
  console.log("\n▌ Block B — Per-item PATCH guard (synthetic fixtures)\n");

  const fixtureLines: LineFixture[] = [
    { id: "ln_fresh", sku_snapshot: "FRESH", qty_ordered: 10, qty_received: 0 },
    { id: "ln_partial", sku_snapshot: "PARTIAL", qty_ordered: 10, qty_received: 5 },
    { id: "ln_full", sku_snapshot: "FULL", qty_ordered: 8, qty_received: 8 },
  ];

  // Case 4: reduce qty_ordered 10→5 when qty_received=5
  let r = runPerItemGuard(
    fixtureLines,
    [{ id: "ln_partial", qty_ordered: 5 }],
    []
  );
  record(
    "Reduce qty_ordered 10→5 when qty_received=5",
    r.ok,
    r.ok ? "allowed" : r.errors.join(" | ")
  );

  // Case 5: reduce qty_ordered 10→4 when qty_received=5 (below received)
  r = runPerItemGuard(
    fixtureLines,
    [{ id: "ln_partial", qty_ordered: 4 }],
    []
  );
  record(
    "Reduce qty_ordered 10→4 when qty_received=5 must be rejected (line_locked)",
    !r.ok && r.errors.some((e) => e.includes("cannot go below qty_received"))
  );

  // Case 6: bump qty_ordered on a fully-received line (8→12)
  r = runPerItemGuard(fixtureLines, [{ id: "ln_full", qty_ordered: 12 }], []);
  record(
    "Bump qty_ordered on fully-received line 8→12 allowed (the main fix)",
    r.ok,
    r.ok ? "allowed" : r.errors.join(" | ")
  );

  // Case 7: delete a line with qty_received=0
  r = runPerItemGuard(fixtureLines, [], ["ln_fresh"]);
  record(
    "Delete line with qty_received=0 allowed",
    r.ok,
    r.ok ? "allowed" : r.errors.join(" | ")
  );

  // Case 8: delete a line with qty_received>0
  r = runPerItemGuard(fixtureLines, [], ["ln_partial"]);
  record(
    "Delete line with qty_received=5 must be rejected",
    !r.ok && r.errors.some((e) => e.includes("cannot be deleted"))
  );

  // Case 9: qty_ordered = 0 when qty_received = 0
  r = runPerItemGuard(fixtureLines, [{ id: "ln_fresh", qty_ordered: 0 }], []);
  record(
    "qty_ordered=0 when qty_received=0 allowed",
    r.ok,
    r.ok ? "allowed" : r.errors.join(" | ")
  );

  // Case 9b: qty_ordered = 0 when qty_received > 0 must reject
  r = runPerItemGuard(fixtureLines, [{ id: "ln_partial", qty_ordered: 0 }], []);
  record(
    "qty_ordered=0 when qty_received=5 must be rejected",
    !r.ok && r.errors.some((e) => e.includes("cannot go below qty_received"))
  );

  // ── Block C: Real DB integration — create + verify guards on actual rows
  console.log("\n▌ Block C — Real DB write/read against sandbox\n");

  let createdPoId: string | null = null;
  try {
    const vendors = (await qbService.listQbVendors(
      { is_active: true },
      { take: 1 }
    )) as unknown as Array<{ id: string; qb_list_id: string; full_name: string }>;
    if (vendors.length === 0) {
      record("[DB] vendor lookup", false, "no active vendor in sandbox");
      throw new Error("no vendor");
    }
    const vendor = vendors[0];

    const [po] = await poService.createPurchaseOrders([
      {
        status: "draft",
        vendor_id: vendor.id,
        stock_location_id: "sloc_01KFS2AV3TAKR141KC2D6JCGTR",
        ordered_at: new Date(),
        memo: "Edit-guard test PO",
        reference_number: "EDIT-GUARD-TEST",
        subtotal_cents: 0,
        tax_cents: 0,
        shipping_cents: 0,
        other_fees_cents: 0,
        total_cents: 0,
        total_lines: 3,
        total_units_ordered: 28,
        created_by_user_id: "user_test_edit_guards",
      },
    ]);
    if (!po) throw new Error("createPurchaseOrders returned no row");
    createdPoId = po.id as string;

    await poService.createPurchaseOrderLines([
      {
        purchase_order_id: createdPoId,
        product_variant_id: "variant_test_a",
        inventory_item_id: "iitem_test_a",
        sku_snapshot: "TEST-A-FRESH",
        description_snapshot: "Fresh line",
        qty_ordered: 10,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 1000,
        status: "open",
        line_order: 0,
      },
      {
        purchase_order_id: createdPoId,
        product_variant_id: "variant_test_b",
        inventory_item_id: "iitem_test_b",
        sku_snapshot: "TEST-B-PARTIAL",
        description_snapshot: "Partial line",
        qty_ordered: 10,
        qty_received: 5,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 1000,
        status: "partial",
        line_order: 1,
      },
      {
        purchase_order_id: createdPoId,
        product_variant_id: "variant_test_c",
        inventory_item_id: "iitem_test_c",
        sku_snapshot: "TEST-C-FULL",
        description_snapshot: "Fully received line",
        qty_ordered: 8,
        qty_received: 8,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 800,
        status: "complete",
        line_order: 2,
      },
    ]);

    record("[DB] PO with 3 lines created", true, `id=${createdPoId}`);

    const dbLines = (await poService.listPurchaseOrderLines(
      { purchase_order_id: createdPoId },
      { take: 100, skip: 0 }
    )) as Array<LineFixture & Record<string, unknown>>;

    const full = dbLines.find((l) => l.sku_snapshot === "TEST-C-FULL");
    if (!full) throw new Error("missing TEST-C-FULL line in DB");

    // Simulate the main fix: bump qty_ordered on the fully-received line
    const updateResult = await poService.updatePurchaseOrderLines([
      { id: full.id, qty_ordered: 12 },
    ]);
    record(
      "[DB] Bump qty_ordered 8→12 on fully-received line",
      Array.isArray(updateResult) && updateResult.length === 1
    );

    // Re-read and confirm
    const after = (await poService.listPurchaseOrderLines(
      { id: [full.id] },
      { take: 1, skip: 0 }
    )) as Array<LineFixture & Record<string, unknown>>;
    record(
      "[DB] Re-read line shows qty_ordered=12, qty_received=8",
      Number(after[0]?.qty_ordered) === 12 &&
        Number(after[0]?.qty_received) === 8,
      `qty_ordered=${after[0]?.qty_ordered}, qty_received=${after[0]?.qty_received}`
    );
  } catch (err) {
    record("[DB] integration block", false, String((err as Error).message));
  } finally {
    if (createdPoId) {
      try {
        const dbLines = (await poService.listPurchaseOrderLines(
          { purchase_order_id: createdPoId },
          { take: 100, skip: 0 }
        )) as Array<{ id: string }>;
        if (dbLines.length > 0) {
          await poService.deletePurchaseOrderLines(dbLines.map((l) => l.id));
        }
        await poService.deletePurchaseOrders([createdPoId]);
        console.log(`\n  [cleanup] deleted PO ${createdPoId} + its lines`);
      } catch (err) {
        console.log(
          `\n  [cleanup] failed to clean PO ${createdPoId}: ${String(
            (err as Error).message
          )}`
        );
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${passed} passed / ${failed} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  if (failed > 0) {
    process.exitCode = 1;
    console.log("Failed cases:");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name}`));
  }
}
