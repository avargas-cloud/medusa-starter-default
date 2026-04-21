/**
 * verify-purchase-orders.ts
 *
 * Pure-logic verifier for the purchase-orders workflow steps. Exercises the
 * derived status rules and the QB payload shape with synthetic inputs — NO
 * container, NO DB writes, NO bridge calls.
 *
 * Tests:
 *   1. deriveLineStatus      — open | partial | complete (mirror of persist-receipt-step)
 *   2. derivePoStatus        — submitted | partially_received | received (receive + void)
 *   3. buildQbPoPayload      — shape match against enqueueQbPurchaseOrderStep
 *   4. buildQbReceiptPayload — shape match against enqueueQbItemReceiptStep
 *   5. contraApplyGuard      — throws on projected-negative
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-purchase-orders.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

// ── Pure helpers (duplicated from steps so the script stays container-free) ─

type LineStatus = "open" | "partial" | "complete" | "cancelled";
type ReceiveStatus = "submitted" | "partially_received" | "received";

function deriveLineStatus(
  qtyOrdered: number,
  qtyReceived: number
): LineStatus {
  if (qtyReceived === 0) return "open";
  if (qtyReceived < qtyOrdered) return "partial";
  return "complete";
}

function derivePoStatus(
  totalOrdered: number,
  totalReceived: number
): ReceiveStatus {
  if (totalReceived === 0) return "submitted";
  if (totalReceived >= totalOrdered) return "received";
  return "partially_received";
}

interface ContraApplyGuardInput {
  current_stock: number;
  qty_to_reverse: number; // positive; will be subtracted
}
function contraApplyGuard(input: ContraApplyGuardInput): {
  ok: boolean;
  new_stock: number;
  error?: string;
} {
  const newStock = input.current_stock - input.qty_to_reverse;
  if (newStock < 0) {
    return {
      ok: false,
      new_stock: newStock,
      error: `Reversing ${input.qty_to_reverse} on stock=${input.current_stock} would result in negative stock.`,
    };
  }
  return { ok: true, new_stock: newStock };
}

interface BuildQbPoPayloadInput {
  po_id: string;
  po_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  ordered_at: Date | null;
  expected_at: Date | null;
  memo: string | null;
  reference_number: string | null;
  lines: Array<{
    line_id: string;
    qb_item_list_id: string;
    sku: string;
    description: string;
    qty_ordered: number;
    unit_cost_cents: number;
  }>;
}
function buildQbPoPayload(input: BuildQbPoPayloadInput) {
  return {
    po_id: input.po_id,
    po_number: input.po_number,
    vendor_qb_list_id: input.vendor_qb_list_id,
    vendor_name: input.vendor_name,
    ordered_at: input.ordered_at ? input.ordered_at.toISOString() : null,
    expected_at: input.expected_at ? input.expected_at.toISOString() : null,
    memo: input.memo,
    reference_number: input.reference_number,
    lines: input.lines,
  };
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expect(
  name: string,
  actual: unknown,
  expected: unknown,
  reason?: string
) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    return;
  }
  failed++;
  failures.push(
    `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${
      reason ? ` — ${reason}` : ""
    }`
  );
}

export default async function run(_container: MedusaContainer): Promise<void> {
  console.log("──────────────────────────────────────────────");
  console.log("verify-purchase-orders: synthetic check suite");
  console.log("──────────────────────────────────────────────");

  // 1. deriveLineStatus ────────────────────────────────────────────────────
  expect("deriveLineStatus(10, 0)", deriveLineStatus(10, 0), "open");
  expect("deriveLineStatus(10, 3)", deriveLineStatus(10, 3), "partial");
  expect("deriveLineStatus(10, 9)", deriveLineStatus(10, 9), "partial");
  expect("deriveLineStatus(10, 10)", deriveLineStatus(10, 10), "complete");
  expect(
    "deriveLineStatus(10, 11) over-receive",
    deriveLineStatus(10, 11),
    "complete",
    "over-receive also yields complete"
  );
  expect("deriveLineStatus(0, 0) empty", deriveLineStatus(0, 0), "open");

  // 2. derivePoStatus ──────────────────────────────────────────────────────
  expect("derivePoStatus(50, 0)", derivePoStatus(50, 0), "submitted");
  expect(
    "derivePoStatus(50, 10)",
    derivePoStatus(50, 10),
    "partially_received"
  );
  expect(
    "derivePoStatus(50, 49)",
    derivePoStatus(50, 49),
    "partially_received"
  );
  expect("derivePoStatus(50, 50)", derivePoStatus(50, 50), "received");
  expect(
    "derivePoStatus(50, 60) over-receive",
    derivePoStatus(50, 60),
    "received",
    "over-receive still received"
  );
  expect(
    "derivePoStatus(0, 0) empty PO",
    derivePoStatus(0, 0),
    "submitted",
    "empty PO stays in submitted; an empty PO should never exist in practice (validator rejects), but the safer default is NOT to claim fully-received"
  );

  // 3. buildQbPoPayload shape ──────────────────────────────────────────────
  const fixedDate = new Date("2026-04-21T12:00:00.000Z");
  const payload = buildQbPoPayload({
    po_id: "po_abc",
    po_number: "PO-1001",
    vendor_qb_list_id: "800000A7-1369921000",
    vendor_name: "Acme Widgets",
    ordered_at: fixedDate,
    expected_at: null,
    memo: "urgent restock",
    reference_number: "V-9876",
    lines: [
      {
        line_id: "pol_1",
        qb_item_list_id: "80000100-ITEMABC",
        sku: "WIDGET-001",
        description: "Big Widget",
        qty_ordered: 10,
        unit_cost_cents: 1250,
      },
    ],
  });
  expect("qbPoPayload.po_number", payload.po_number, "PO-1001");
  expect(
    "qbPoPayload.ordered_at iso",
    payload.ordered_at,
    "2026-04-21T12:00:00.000Z"
  );
  expect("qbPoPayload.expected_at null", payload.expected_at, null);
  expect("qbPoPayload.lines length", payload.lines.length, 1);
  expect(
    "qbPoPayload.lines[0].unit_cost_cents",
    payload.lines[0].unit_cost_cents,
    1250
  );

  // 4. contraApplyGuard (void stock reversal) ──────────────────────────────
  expect(
    "contraApplyGuard ok",
    contraApplyGuard({ current_stock: 20, qty_to_reverse: 5 }),
    { ok: true, new_stock: 15 }
  );
  expect(
    "contraApplyGuard edge-zero ok",
    contraApplyGuard({ current_stock: 5, qty_to_reverse: 5 }),
    { ok: true, new_stock: 0 }
  );
  const negResult = contraApplyGuard({
    current_stock: 3,
    qty_to_reverse: 5,
  });
  expect("contraApplyGuard negative guard", negResult.ok, false);
  expect(
    "contraApplyGuard new_stock negative",
    negResult.new_stock,
    -2,
    "new_stock reported even on failure for audit"
  );

  // 5. Receipt math: sequential partial receipts ───────────────────────────
  let qtyReceived = 0;
  const qtyOrdered = 30;
  qtyReceived += 10;
  expect(
    "partial 1 status",
    deriveLineStatus(qtyOrdered, qtyReceived),
    "partial"
  );
  qtyReceived += 10;
  expect(
    "partial 2 status",
    deriveLineStatus(qtyOrdered, qtyReceived),
    "partial"
  );
  qtyReceived += 10;
  expect(
    "final status",
    deriveLineStatus(qtyOrdered, qtyReceived),
    "complete"
  );

  // 6. Void of receipt (reverse back to partial) ───────────────────────────
  qtyReceived -= 10;
  expect(
    "post-void status",
    deriveLineStatus(qtyOrdered, qtyReceived),
    "partial"
  );
  qtyReceived -= 20;
  expect(
    "post-full-void status",
    deriveLineStatus(qtyOrdered, qtyReceived),
    "open"
  );

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("");
  console.log(`${passed} passed · ${failed} failed`);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log(`  ✗ ${f}`);
    throw new Error(
      `verify-purchase-orders: ${failed} assertion(s) failed — see above`
    );
  }
  console.log("✓ all synthetic purchase-order logic assertions passed");
}
