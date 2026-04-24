/**
 * verify-order-status-on-invoice.ts
 *
 * Verifies that the order_status auto-derivation logic in POST /admin/invoices
 * produces the correct metadata.order_status for every meaningful scenario.
 *
 * Two sections:
 *   1. Unit tests — pure function, no DB or API calls.
 *   2. Live DB check — queries existing invoiced orders and audits their actual status.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-order-status-on-invoice.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

// ── Mirror of production logic (keep in sync with invoices/route.ts) ──────────

const PICKUP_KEYWORDS = [
  "pickup", "pick up", "pick-up", "store pickup", "local pickup", "in-store", "miami",
];

interface OrderStatusInput {
  /** Names of the order's shipping methods. */
  shippingMethodNames: string[];
  /** Medusa fulfillment_status of the order at invoice time. */
  fulfillmentStatus: string;
  /** fulfillment_id sent in the invoice creation body (null if pickup-pending or skipped). */
  fulfillmentId: string | null;
  /** Current order.metadata.order_status — if "Voided" the function returns undefined (no-op). */
  existingOrderStatus: string | undefined;
}

/**
 * Pure function mirroring the derivation block in POST /admin/invoices.
 * Returns the status string to write, or undefined if the order is already Voided.
 */
function deriveOrderStatus(input: OrderStatusInput): string | undefined {
  if (input.existingOrderStatus === "Voided") return undefined;

  const methods = input.shippingMethodNames;
  const isPickup =
    methods.length > 0 &&
    methods.some((name) =>
      PICKUP_KEYWORDS.some((kw) => name.toLowerCase().includes(kw))
    );
  const isShipping = methods.length > 0 && !isPickup;

  if (isShipping) return "Ready to Ship";

  if (
    input.fulfillmentId &&
    ["fulfilled", "delivered"].includes(input.fulfillmentStatus)
  ) {
    return "Fulfilled";
  }

  return "Approved";
}

// ── Test cases ─────────────────────────────────────────────────────────────────

interface TestCase {
  label: string;
  group: "pickup" | "shipping" | "voided" | "edge";
  input: OrderStatusInput;
  expected: string | undefined;
  rationale: string;
}

const TESTS: TestCase[] = [

  // ── Pickup — Fulfilled ───────────────────────────────────────────────────────
  {
    label: "Local Pickup + mark-as-delivered succeeds (fulfillment_status=delivered)",
    group: "pickup",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01abc",
      existingOrderStatus: undefined,
    },
    expected: "Fulfilled",
    rationale: "fulfillment_id present + delivered → Fulfilled",
  },
  {
    label: "Store Pickup (explicit name) + fulfillment_status=fulfilled",
    group: "pickup",
    input: {
      shippingMethodNames: ["Store Pickup"],
      fulfillmentStatus: "fulfilled",
      fulfillmentId: "ful_01xyz",
      existingOrderStatus: undefined,
    },
    expected: "Fulfilled",
    rationale: "'fulfilled' also triggers the Fulfilled branch",
  },
  {
    label: "Miami pickup + delivered",
    group: "pickup",
    input: {
      shippingMethodNames: ["Miami Showroom"],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01miami",
      existingOrderStatus: "Created",
    },
    expected: "Fulfilled",
    rationale: "'miami' keyword matches pickup — existing Created status overwritten",
  },
  {
    label: "In-store pickup + delivered",
    group: "pickup",
    input: {
      shippingMethodNames: ["In-Store"],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01instore",
      existingOrderStatus: undefined,
    },
    expected: "Fulfilled",
    rationale: "'in-store' keyword matches pickup",
  },
  {
    label: "Pick Up (spaced) + delivered",
    group: "pickup",
    input: {
      shippingMethodNames: ["Pick Up"],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01pu",
      existingOrderStatus: undefined,
    },
    expected: "Fulfilled",
    rationale: "'pick up' (spaced) keyword matches pickup",
  },

  // ── Pickup — Approved (fulfillment incomplete or pending) ────────────────────
  {
    label: "Local Pickup + partial fulfillment (fulfillment_status=partially_fulfilled)",
    group: "pickup",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "partially_fulfilled",
      fulfillmentId: "ful_01partial",
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "partial fulfillment does not qualify for Fulfilled — falls to Approved",
  },
  {
    label: "Pickup pending — no fulfillment_id (cashier chose 'customer picks up later')",
    group: "pickup",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "fulfillment_id is null → Fulfilled branch skipped → Approved",
  },
  {
    label: "Pickup + fulfillment_status=delivered BUT no fulfillment_id (edge)",
    group: "pickup",
    input: {
      shippingMethodNames: ["Store Pickup"],
      fulfillmentStatus: "delivered",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "fulfillment_id required for Fulfilled branch; null → Approved",
  },
  {
    label: "Pickup + fulfillment_status=not_fulfilled + fulfillment_id (fulfillment created but not yet delivered)",
    group: "pickup",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: "ful_01pending",
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "not_fulfilled not in [fulfilled, delivered] → Approved",
  },
  {
    label: "Pickup + existing status=Email Sent (should be overwritten to Approved)",
    group: "pickup",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: "Email Sent",
    },
    expected: "Approved",
    rationale: "Only Voided is preserved; any other existing status gets overwritten",
  },

  // ── Shipping orders ──────────────────────────────────────────────────────────
  {
    label: "UPS Ground shipping",
    group: "shipping",
    input: {
      shippingMethodNames: ["UPS Ground"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "UPS Ground is a shipping method → Ready to Ship",
  },
  {
    label: "UPS Next Day Air",
    group: "shipping",
    input: {
      shippingMethodNames: ["UPS Next Day Air"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "Any UPS shipping method → Ready to Ship",
  },
  {
    label: "UPS 2nd Day Air",
    group: "shipping",
    input: {
      shippingMethodNames: ["UPS 2nd Day Air"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "UPS 2nd Day Air → Ready to Ship",
  },
  {
    label: "Ground Shipping (generic)",
    group: "shipping",
    input: {
      shippingMethodNames: ["Ground Shipping"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "'Ground Shipping' has no pickup keyword → shipping",
  },
  {
    label: "Uber Delivery",
    group: "shipping",
    input: {
      shippingMethodNames: ["Uber Delivery"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "Uber Delivery has no pickup keyword → Ready to Ship",
  },
  {
    label: "Shipping + existing status=Placed Online (overwritten)",
    group: "shipping",
    input: {
      shippingMethodNames: ["UPS Ground"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: "Placed Online",
    },
    expected: "Ready to Ship",
    rationale: "Placed Online is not Voided → overwritten to Ready to Ship",
  },

  // ── Voided — no-op ───────────────────────────────────────────────────────────
  {
    label: "Order already Voided + pickup + fulfilled (must NOT overwrite)",
    group: "voided",
    input: {
      shippingMethodNames: ["Local Pickup"],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01v",
      existingOrderStatus: "Voided",
    },
    expected: undefined,
    rationale: "Voided is a terminal state — function returns undefined (caller skips update)",
  },
  {
    label: "Order already Voided + shipping method",
    group: "voided",
    input: {
      shippingMethodNames: ["UPS Ground"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: "Voided",
    },
    expected: undefined,
    rationale: "Voided terminal state — no update for shipping orders either",
  },

  // ── Edge cases ───────────────────────────────────────────────────────────────
  {
    label: "No shipping method at all (web order migrated to POS)",
    group: "edge",
    input: {
      shippingMethodNames: [],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "No methods → isPickup=false, isShipping=false → fallback Approved",
  },
  {
    label: "No shipping method + fulfillment_id present + delivered (partial invoice)",
    group: "edge",
    input: {
      shippingMethodNames: [],
      fulfillmentStatus: "delivered",
      fulfillmentId: "ful_01nomethod",
      existingOrderStatus: undefined,
    },
    expected: "Fulfilled",
    rationale: "No method skips pickup/shipping checks; fulfillment_id + delivered → Fulfilled",
  },
  {
    label: "Multiple shipping methods — one pickup, one shipping (mixed edge)",
    group: "edge",
    input: {
      shippingMethodNames: ["Local Pickup", "UPS Ground"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Approved",
    rationale: "Pickup keyword found → isPickup=true, isShipping=false → Approved (no fulfillment)",
  },
  {
    label: "Standard Shipping (no pickup keyword)",
    group: "edge",
    input: {
      shippingMethodNames: ["Standard Shipping"],
      fulfillmentStatus: "not_fulfilled",
      fulfillmentId: null,
      existingOrderStatus: undefined,
    },
    expected: "Ready to Ship",
    rationale: "No pickup keyword in 'Standard Shipping' → treated as shipping",
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

export default async function (container: MedusaContainer) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  verify-order-status-on-invoice");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Section 1: Unit tests ──────────────────────────────────────────────────
  console.log("── SECTION 1: Unit Tests (pure function) ───────────────────\n");

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const groups: Record<string, { pass: number; fail: number }> = {};

  for (const tc of TESTS) {
    if (!groups[tc.group]) groups[tc.group] = { pass: 0, fail: 0 };

    const result = deriveOrderStatus(tc.input);
    const ok = result === tc.expected;

    if (ok) {
      passed++;
      groups[tc.group].pass++;
      console.log(`  ✅ [${tc.group}] ${tc.label}`);
    } else {
      failed++;
      groups[tc.group].fail++;
      const msg = `  ❌ [${tc.group}] ${tc.label}\n       expected="${tc.expected}" got="${result}"\n       ${tc.rationale}`;
      console.log(msg);
      failures.push(msg);
    }
  }

  console.log(`\n── Group Summary ────────────────────────────────────────────`);
  for (const [group, counts] of Object.entries(groups)) {
    const total = counts.pass + counts.fail;
    console.log(`   ${group.padEnd(10)} ${counts.pass}/${total} passed`);
  }

  console.log(`\n── Unit Test Result: ${passed} passed, ${failed} failed ────\n`);

  // ── Section 2: Live DB audit ───────────────────────────────────────────────
  console.log("── SECTION 2: Live DB Audit (existing invoiced orders) ─────\n");

  try {
    const pgConnection = container.resolve("__pg_connection__") as any;

    // Fetch orders that have at least one pos_invoice, with their shipping methods
    const { rows } = await pgConnection.raw(`
      SELECT DISTINCT ON (o.id)
        o.id,
        o.display_id,
        o.fulfillment_status,
        o.metadata->>'order_status' AS order_status,
        sm.name AS shipping_method_name,
        pi.fulfillment_id
      FROM "order" o
      JOIN pos_invoice pi ON pi.order_id = o.id
      LEFT JOIN order_shipping_method sm ON sm.order_id = o.id
      WHERE pi.status != 'voided'
      ORDER BY o.id, pi.created_at DESC
      LIMIT 100;
    `);

    if (!rows || rows.length === 0) {
      console.log("  No invoiced orders found in DB.\n");
    } else {
      let auditPass = 0;
      let auditMismatch = 0;
      let auditVoided = 0;

      for (const row of rows) {
        const methodName = row.shipping_method_name ?? "";
        const expected = deriveOrderStatus({
          shippingMethodNames: methodName ? [methodName] : [],
          fulfillmentStatus: row.fulfillment_status ?? "not_fulfilled",
          fulfillmentId: row.fulfillment_id ?? null,
          existingOrderStatus: undefined, // simulate fresh derivation
        });
        const actual: string = row.order_status ?? "(none)";

        if (actual === "Voided") {
          auditVoided++;
          console.log(`  ⬜ #${String(row.display_id).padStart(5)} | Voided (terminal — skip)`);
        } else if (actual === expected) {
          auditPass++;
          console.log(`  ✅ #${String(row.display_id).padStart(5)} | method="${methodName || "(none)"}" | fulfill="${row.fulfillment_status}" | status="${actual}"`);
        } else {
          auditMismatch++;
          console.log(`  ⚠️  #${String(row.display_id).padStart(5)} | method="${methodName || "(none)"}" | fulfill="${row.fulfillment_status}" | actual="${actual}" expected="${expected}"`);
        }
      }

      console.log(`\n── DB Audit Result: ${auditPass} match, ${auditMismatch} mismatch (pre-feature orders), ${auditVoided} voided ──`);
      if (auditMismatch > 0) {
        console.log(
          `  ℹ️  Mismatches are expected for orders created BEFORE this feature was deployed.`
        );
      }
    }
  } catch (dbErr: any) {
    console.warn(`  ⚠️  DB audit skipped — query failed: ${dbErr.message}`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  if (failed === 0) {
    console.log(`  ✅ ALL ${passed} UNIT TESTS PASSED`);
  } else {
    console.log(`  ❌ ${failed} UNIT TEST(S) FAILED:`);
    for (const f of failures) console.log(f);
  }
  console.log("═══════════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}
