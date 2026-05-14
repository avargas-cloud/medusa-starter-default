/**
 * src/scripts/tests/test-fo-patch-fix.ts
 *
 * Validates the FO PATCH refactor: diff-reconciliation + per-item guards.
 * Drives the actual handler via http-mocks so we exercise zod validation,
 * the diff path, and the guard rejects.
 *
 * Run: npx medusa exec ./src/scripts/tests/test-fo-patch-fix.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { FACTORY_ORDERS_MODULE } from "../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../modules/factory-orders/service";
import { PATCH as foPatch } from "../../api/admin/factory-orders/[id]/route";

let results: { name: string; ok: boolean; note?: string }[] = [];
function record(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
}

type ResMock = {
  status: (n: number) => ResMock;
  json: (b: unknown) => void;
  _status?: number;
  _body?: any;
};

function makeRes(): ResMock {
  const r: ResMock = {
    status(n) {
      r._status = n;
      return r;
    },
    json(b) {
      r._body = b;
    },
  };
  r._status = 200;
  return r;
}

function makeReq(
  container: MedusaContainer,
  id: string,
  body: any
): any {
  return {
    params: { id },
    body,
    scope: container,
    auth_context: {
      actor_id: "user_test",
      actor_type: "user",
      app_metadata: { user_id: "user_test" },
    },
  };
}

export default async function test({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const foService = container.resolve(
    FACTORY_ORDERS_MODULE
  ) as unknown as FactoryOrdersModuleService;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  FO PATCH refactor — diff-reconciliation + guards");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  let foId: string | null = null;
  let lineAId = "";
  let lineBId = "";

  try {
    const [fo] = await foService.createFactoryOrders([
      {
        status: "partially_received",
        vendor_id: "qbv_fixture",
        vendor_name_snapshot: "Test Vendor",
        stock_location_id: "sloc_01KQ14C1CFX30EDD722BF87HDM",
        ordered_at: new Date(),
        memo: "Original memo",
        reference_number: "FO-FIX-TEST",
        subtotal_cents: 8000,
        tax_cents: 0,
        shipping_cents: 0,
        other_fees_cents: 0,
        total_cents: 8000,
        total_lines: 2,
        total_units_ordered: 80,
        total_units_received: 5,
        created_by_user_id: "user_test",
      },
    ]);
    foId = fo.id as string;

    const created = await foService.createFactoryOrderLines([
      {
        factory_order_id: foId,
        product_variant_id: "variant_fixture_a",
        inventory_item_id: "iitem_fixture_a",
        sku_snapshot: "FIX-A",
        description_snapshot: "Line A",
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
        factory_order_id: foId,
        product_variant_id: "variant_fixture_b",
        inventory_item_id: "iitem_fixture_b",
        sku_snapshot: "FIX-B",
        description_snapshot: "Line B",
        qty_ordered: 30,
        qty_received: 5,
        qty_cancelled: 0,
        unit_cost_cents: 100,
        tax_cents: 0,
        total_cents: 3000,
        status: "partial",
        line_order: 1,
      },
    ]);
    lineAId = (created as Array<{ id: string }>)[0].id;
    lineBId = (created as Array<{ id: string }>)[1].id;
    record("Fixture: FO + 2 lines (B.qty_received=5)", true, `foId=${foId}`);

    // ── Case 1: edit description on line A; resend both lines with ids.
    // Expected: qty_received on B preserved (5), ids unchanged.
    const linesPayload1 = [
      {
        id: lineAId,
        product_variant_id: "variant_fixture_a",
        inventory_item_id: "iitem_fixture_a",
        sku_snapshot: "FIX-A",
        description_snapshot: "EDITED Line A",
        qty_ordered: 50,
        unit_cost_cents: 100,
        line_order: 0,
      },
      {
        id: lineBId,
        product_variant_id: "variant_fixture_b",
        inventory_item_id: "iitem_fixture_b",
        sku_snapshot: "FIX-B",
        description_snapshot: "Line B",
        qty_ordered: 30,
        unit_cost_cents: 100,
        line_order: 1,
      },
    ];
    const req1 = makeReq(container, foId, { lines: linesPayload1 });
    const res1 = makeRes();
    await foPatch(req1, res1 as any);
    record(
      "Case 1 PATCH ok (status 200)",
      res1._status === 200,
      `status=${res1._status}`
    );

    const after1 = (await foService.listFactoryOrderLines(
      { factory_order_id: foId },
      { take: 100, skip: 0 }
    )) as Array<{
      id: string;
      sku_snapshot: string;
      qty_ordered: number;
      qty_received: number;
      status: string;
      description_snapshot: string;
    }>;
    const a1A = after1.find((l) => l.sku_snapshot === "FIX-A");
    const a1B = after1.find((l) => l.sku_snapshot === "FIX-B");
    record(
      "Line A id preserved + description updated",
      a1A?.id === lineAId && a1A?.description_snapshot === "EDITED Line A",
      `id stable=${a1A?.id === lineAId}, desc="${a1A?.description_snapshot}"`
    );
    record(
      "Line B id preserved",
      a1B?.id === lineBId,
      `id=${a1B?.id} (was ${lineBId})`
    );
    record(
      "Line B qty_received PRESERVED (was 5)",
      a1B?.qty_received === 5,
      `qty_received=${a1B?.qty_received}`
    );
    record(
      "Line B status preserved ('partial')",
      a1B?.status === "partial",
      `status=${a1B?.status}`
    );

    // ── Case 2: per-item guard — try to drop B qty_ordered to 3 (below recv=5).
    const req2 = makeReq(container, foId, {
      lines: [
        {
          id: lineAId,
          product_variant_id: "variant_fixture_a",
          inventory_item_id: "iitem_fixture_a",
          sku_snapshot: "FIX-A",
          description_snapshot: "EDITED Line A",
          qty_ordered: 50,
          unit_cost_cents: 100,
        },
        {
          id: lineBId,
          product_variant_id: "variant_fixture_b",
          inventory_item_id: "iitem_fixture_b",
          sku_snapshot: "FIX-B",
          description_snapshot: "Line B",
          qty_ordered: 3, // below qty_received=5
          unit_cost_cents: 100,
        },
      ],
    });
    const res2 = makeRes();
    await foPatch(req2, res2 as any);
    record(
      "Case 2 guard rejects qty_ordered<received (409 line_locked)",
      res2._status === 409 && res2._body?.code === "line_locked",
      `status=${res2._status}, code=${res2._body?.code}`
    );

    // ── Case 3: per-item guard — try to delete line B (received=5).
    const req3 = makeReq(container, foId, {
      lines: [
        {
          id: lineAId,
          product_variant_id: "variant_fixture_a",
          inventory_item_id: "iitem_fixture_a",
          sku_snapshot: "FIX-A",
          description_snapshot: "EDITED Line A",
          qty_ordered: 50,
          unit_cost_cents: 100,
        },
        // line B omitted → should be flagged for delete
      ],
    });
    const res3 = makeRes();
    await foPatch(req3, res3 as any);
    record(
      "Case 3 guard rejects delete of partially-received line (409 line_locked)",
      res3._status === 409 && res3._body?.code === "line_locked",
      `status=${res3._status}, code=${res3._body?.code}`
    );

    // ── Case 4: bump line A 50→60 + bump line B 30→40 (legitimate edits)
    const req4 = makeReq(container, foId, {
      lines: [
        {
          id: lineAId,
          product_variant_id: "variant_fixture_a",
          inventory_item_id: "iitem_fixture_a",
          sku_snapshot: "FIX-A",
          description_snapshot: "EDITED Line A",
          qty_ordered: 60,
          unit_cost_cents: 100,
        },
        {
          id: lineBId,
          product_variant_id: "variant_fixture_b",
          inventory_item_id: "iitem_fixture_b",
          sku_snapshot: "FIX-B",
          description_snapshot: "Line B",
          qty_ordered: 40,
          unit_cost_cents: 100,
        },
      ],
    });
    const res4 = makeRes();
    await foPatch(req4, res4 as any);
    record(
      "Case 4 PATCH ok bumping quantities",
      res4._status === 200,
      `status=${res4._status}`
    );

    const after4 = (await foService.listFactoryOrderLines(
      { factory_order_id: foId },
      { take: 100, skip: 0 }
    )) as Array<{
      id: string;
      sku_snapshot: string;
      qty_ordered: number;
      qty_received: number;
    }>;
    const a4B = after4.find((l) => l.sku_snapshot === "FIX-B");
    record(
      "After bumps: line B id preserved, qty_ordered=40, qty_received still 5",
      a4B?.id === lineBId && a4B?.qty_ordered === 40 && a4B?.qty_received === 5,
      `id=${a4B?.id === lineBId} ordered=${a4B?.qty_ordered} recv=${a4B?.qty_received}`
    );

    // ── Case 5: add a new line (no id). Expected: insert without touching others.
    const req5 = makeReq(container, foId, {
      lines: [
        {
          id: lineAId,
          product_variant_id: "variant_fixture_a",
          inventory_item_id: "iitem_fixture_a",
          sku_snapshot: "FIX-A",
          description_snapshot: "EDITED Line A",
          qty_ordered: 60,
          unit_cost_cents: 100,
        },
        {
          id: lineBId,
          product_variant_id: "variant_fixture_b",
          inventory_item_id: "iitem_fixture_b",
          sku_snapshot: "FIX-B",
          description_snapshot: "Line B",
          qty_ordered: 40,
          unit_cost_cents: 100,
        },
        {
          product_variant_id: "variant_fixture_c",
          inventory_item_id: "iitem_fixture_c",
          sku_snapshot: "FIX-C",
          description_snapshot: "New line C",
          qty_ordered: 10,
          unit_cost_cents: 100,
        },
      ],
    });
    const res5 = makeRes();
    await foPatch(req5, res5 as any);
    record(
      "Case 5 PATCH adds new line",
      res5._status === 200,
      `status=${res5._status}`
    );

    const after5 = (await foService.listFactoryOrderLines(
      { factory_order_id: foId },
      { take: 100, skip: 0 }
    )) as Array<{
      sku_snapshot: string;
      qty_received: number;
      id: string;
    }>;
    const a5C = after5.find((l) => l.sku_snapshot === "FIX-C");
    const a5B = after5.find((l) => l.sku_snapshot === "FIX-B");
    record(
      "New line C inserted with qty_received=0",
      a5C !== undefined && a5C.qty_received === 0,
      `present=${!!a5C}, qty_received=${a5C?.qty_received}`
    );
    record(
      "Line B qty_received STILL 5 after add (no wipe)",
      a5B?.qty_received === 5 && a5B?.id === lineBId,
      `recv=${a5B?.qty_received}, id stable=${a5B?.id === lineBId}`
    );
    record(
      "Now 3 active lines on the FO",
      after5.length === 3,
      `lines=${after5.length}`
    );
  } catch (err) {
    record("Setup/execution", false, String((err as Error).message));
    console.error(err);
  } finally {
    if (foId) {
      try {
        const lns = (await foService.listFactoryOrderLines(
          { factory_order_id: foId },
          { take: 100, skip: 0 }
        )) as Array<{ id: string }>;
        if (lns.length > 0) {
          await foService.deleteFactoryOrderLines(lns.map((l) => l.id));
        }
        await foService.deleteFactoryOrders([foId]);
        console.log(`\n  [cleanup] deleted FO ${foId} + lines`);
      } catch (err) {
        console.log(`\n  [cleanup] failed: ${String((err as Error).message)}`);
      }
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${passed} passed / ${failed} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  if (failed > 0) {
    process.exitCode = 1;
    console.log("Failed:");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name}${r.note ? ` — ${r.note}` : ""}`));
  }
}
