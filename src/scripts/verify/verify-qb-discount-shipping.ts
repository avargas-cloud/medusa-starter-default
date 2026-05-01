/**
 * Verifies the QB discount + shipping prebuiltItems generation against
 * a real Medusa order. Designed to run in sandbox (DATABASE_URL pointing to
 * port 5499). Compares the NEW behavior (with getEffectiveOrderDiscount and
 * the un-gated discount/shipping logic) against scenarios that previously
 * failed in production.
 *
 * Run: cd backend && DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   npx medusa exec ./src/scripts/verify/verify-qb-discount-shipping.ts
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";

import {
  buildQbItems,
  buildShippingQbItem,
  buildQbOrderDiscountLines,
  getEffectiveOrderDiscount,
} from "../../lib/quickbooks/order-flow-core";

interface Scenario {
  name: string;
  orderDisplayId?: number;
  expect: {
    discount?: number;
    discountTolerance?: number;
    hasShipping?: boolean;
    minItemCount?: number;
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "Order 1350 — 12% promo as 7 per-item adjustments ($875.33 total)",
    orderDisplayId: 1350,
    expect: { discount: 875.33, discountTolerance: 0.05 },
  },
  {
    name: "Order 1576 — recent order with promo adjustments ($278.04)",
    orderDisplayId: 1576,
    expect: { discount: 278.04, discountTolerance: 0.05 },
  },
  {
    name: "Order 1565 — promo adjustments ($1384.94)",
    orderDisplayId: 1565,
    expect: { discount: 1384.94, discountTolerance: 0.05 },
  },
  {
    name: "Order 1495 — large promo adjustments ($6251.89)",
    orderDisplayId: 1495,
    expect: { discount: 6251.89, discountTolerance: 0.05 },
  },
  {
    name: "Order 1465 — promo adjustments ($196.14)",
    orderDisplayId: 1465,
    expect: { discount: 196.14, discountTolerance: 0.05 },
  },
];

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface SyntheticTest {
  name: string;
  order: any;
  expect: { discount: number; hasShipping: boolean };
}

const SYNTHETIC: SyntheticTest[] = [
  {
    name: "discount_total populated only",
    order: { discount_total: 100, items: [], metadata: {} },
    expect: { discount: 100, hasShipping: false },
  },
  {
    name: "adjustments only (discount_total = 0)",
    order: {
      discount_total: 0,
      items: [
        { adjustments: [{ amount: 50, code: "PROMO" }] },
        { adjustments: [{ amount: 25, code: "PROMO" }] },
      ],
      metadata: {},
    },
    expect: { discount: 75, hasShipping: false },
  },
  {
    name: "metadata.computed_discount fallback only",
    order: {
      discount_total: 0,
      items: [{ adjustments: [] }],
      metadata: { computed_discount: 42.5 },
    },
    expect: { discount: 42.5, hasShipping: false },
  },
  {
    name: "no discount, with FedEx shipping",
    order: {
      discount_total: 0,
      items: [],
      metadata: {},
      shipping_methods: [{ name: "FedEx Ground", amount: 25.5 }],
    },
    expect: { discount: 0, hasShipping: true },
  },
  {
    name: "discount + shipping (production-like full case)",
    order: {
      discount_total: 0,
      subtotal: 1000,
      items: [
        { adjustments: [{ amount: 100, code: "PROMO10" }] },
      ],
      metadata: {},
      shipping_methods: [{ name: "UPS", amount: 30 }],
    },
    expect: { discount: 100, hasShipping: true },
  },
  {
    name: "store pickup (should NOT add shipping)",
    order: {
      discount_total: 0,
      items: [],
      metadata: {},
      shipping_methods: [{ name: "Store Pickup", amount: 0 }],
    },
    expect: { discount: 0, hasShipping: false },
  },
  {
    name: "deleted adjustments are ignored",
    order: {
      discount_total: 0,
      items: [
        {
          adjustments: [
            { amount: 50, code: "PROMO", deleted_at: null },
            { amount: 100, code: "PROMO", deleted_at: "2026-04-30T00:00:00Z" },
          ],
        },
      ],
      metadata: {},
    },
    expect: { discount: 50, hasShipping: false },
  },
  {
    name: "empty everything → 0 discount, no shipping",
    order: { items: [], metadata: {} },
    expect: { discount: 0, hasShipping: false },
  },
  {
    name: "discount_total takes precedence when > 0",
    order: {
      discount_total: 999,
      items: [{ adjustments: [{ amount: 50 }] }],
      metadata: { computed_discount: 200 },
    },
    expect: { discount: 999, hasShipping: false },
  },
  {
    name: "string-typed discount_total (Medusa raw precision)",
    order: { discount_total: "875.33", items: [], metadata: {} },
    expect: { discount: 875.33, hasShipping: false },
  },
  {
    name: "negative discount_total falls through to adjustments",
    order: {
      discount_total: -10,
      items: [{ adjustments: [{ amount: 25 }] }],
      metadata: {},
    },
    expect: { discount: 25, hasShipping: false },
  },
  {
    name: "free shipping (amount = 0) → no shipping line",
    order: {
      discount_total: 0,
      items: [],
      metadata: {},
      shipping_methods: [{ name: "Free Ground", amount: 0 }],
    },
    expect: { discount: 0, hasShipping: false },
  },
  {
    name: "pickup keyword variations",
    order: {
      discount_total: 0,
      items: [],
      metadata: {},
      shipping_methods: [
        { name: "Pick-up Today", amount: 0 },
        { name: "Local pickup", amount: 0 },
      ],
    },
    expect: { discount: 0, hasShipping: false },
  },
  {
    name: "non-pickup wins when both present",
    order: {
      discount_total: 0,
      items: [],
      metadata: {},
      shipping_methods: [
        { name: "Store Pickup", amount: 0 },
        { name: "FedEx Express", amount: 49.99 },
      ],
    },
    expect: { discount: 0, hasShipping: true },
  },
  {
    name: "all three discount sources zero → 0",
    order: {
      discount_total: 0,
      items: [{ adjustments: [{ amount: 0 }] }],
      metadata: { computed_discount: 0 },
    },
    expect: { discount: 0, hasShipping: false },
  },
];

interface Result {
  name: string;
  passed: boolean;
  reason?: string;
  detail?: string;
}

function runSyntheticTests(): Result[] {
  const results: Result[] = [];
  for (const t of SYNTHETIC) {
    const discount = getEffectiveOrderDiscount(t.order);
    const passed = Math.abs(discount - t.expect.discount) < 0.01;
    const detail = `discount=${fmt(discount)} (expected ${fmt(t.expect.discount)})`;
    results.push({
      name: `[synthetic] ${t.name}`,
      passed,
      reason: passed ? undefined : "discount mismatch",
      detail,
    });

    // Shipping is only computed via buildShippingQbItem
    const ship = buildShippingQbItem(t.order.shipping_methods || []);
    const hasShipping = ship !== null;
    const passedShip = hasShipping === t.expect.hasShipping;
    results.push({
      name: `[synthetic] ${t.name} :: shipping`,
      passed: passedShip,
      reason: passedShip ? undefined : "shipping mismatch",
      detail: `hasShipping=${hasShipping} (expected ${t.expect.hasShipping})`,
    });
  }
  return results;
}

async function runRealOrderTest(
  container: MedusaContainer,
  s: Scenario
): Promise<Result[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const out: Result[] = [];

  let order: any;
  try {
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "subtotal",
        "discount_total",
        "metadata",
        "items.*",
        "items.variant.*",
        "items.variant.metadata",
        "items.adjustments.*",
        "shipping_methods.*",
      ],
      filters: { display_id: s.orderDisplayId! },
    });
    order = data?.[0];
  } catch (err: any) {
    out.push({
      name: `[real] ${s.name}`,
      passed: false,
      reason: `query failed: ${err.message}`,
    });
    return out;
  }

  if (!order) {
    out.push({
      name: `[real] ${s.name}`,
      passed: false,
      reason: `order ${s.orderDisplayId} not found in this DB`,
    });
    return out;
  }

  const discount = getEffectiveOrderDiscount(order);
  const tol = s.expect.discountTolerance ?? 0.05;
  const expected = s.expect.discount ?? 0;
  const passed = Math.abs(discount - expected) < tol;
  out.push({
    name: `[real] ${s.name} :: discount`,
    passed,
    reason: passed ? undefined : `expected ${fmt(expected)}, got ${fmt(discount)}`,
    detail: `display_id=${order.display_id}, discount=${fmt(discount)}, items=${order.items?.length ?? 0}`,
  });

  // Build prebuilt items as the handler would
  const activeItems = (order.items || []).map((it: any) => ({
    ...it,
    quantity: it.quantity,
    unit_price: Number(it.unit_price || 0),
    subtotal: it.subtotal !== undefined ? Number(it.subtotal) : undefined,
  }));
  const prebuilt = buildQbItems(activeItems, order.metadata);
  if (discount > 0) {
    const subtotal = Number(order.subtotal || 0);
    const pct = subtotal > 0 ? (discount / subtotal) * 100 : null;
    buildQbOrderDiscountLines(discount, pct).forEach((l: any) =>
      prebuilt.push(l)
    );
  }
  const ship = buildShippingQbItem(order.shipping_methods || []);
  if (ship) prebuilt.push(ship);

  const subtotalLines = prebuilt.filter(
    (i: any) => i.productName === "Subtotal"
  );
  const discountLines = prebuilt.filter(
    (i: any) => i.productName === "Discount"
  );

  const expectsDiscount = expected > 0;
  const hasDiscountLine = discountLines.length === 1;
  const hasSubtotalLine = subtotalLines.length === 1;
  out.push({
    name: `[real] ${s.name} :: prebuilt has Subtotal+Discount lines`,
    passed: expectsDiscount === (hasDiscountLine && hasSubtotalLine),
    reason:
      expectsDiscount === (hasDiscountLine && hasSubtotalLine)
        ? undefined
        : `expected discount lines presence=${expectsDiscount}, got Subtotal=${hasSubtotalLine} Discount=${hasDiscountLine}`,
    detail: `prebuilt items=${prebuilt.length}`,
  });

  if (hasDiscountLine) {
    const dl = discountLines[0];
    const passedAmt = Math.abs((dl.amount ?? 0) - expected) < tol;
    out.push({
      name: `[real] ${s.name} :: Discount line amount matches`,
      passed: passedAmt,
      reason: passedAmt
        ? undefined
        : `Discount line amount=${dl.amount}, expected ${expected}`,
    });
  }

  return out;
}

export default async function verify({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log("\n=== QB Discount + Shipping Verification ===\n");

  const all: Result[] = [];

  console.log(`-- ${SYNTHETIC.length} synthetic scenarios --`);
  all.push(...runSyntheticTests());

  console.log(`-- ${SCENARIOS.length} real order scenarios --`);
  for (const s of SCENARIOS) {
    const r = await runRealOrderTest(container, s);
    all.push(...r);
  }

  const passed = all.filter((r) => r.passed).length;
  const failed = all.filter((r) => !r.passed);

  console.log("\n=== Results ===");
  for (const r of all) {
    const icon = r.passed ? "✓" : "✗";
    const detail = r.detail ? ` (${r.detail})` : "";
    const reason = r.reason ? ` :: ${r.reason}` : "";
    console.log(`${icon} ${r.name}${detail}${reason}`);
  }

  console.log(
    `\n${passed}/${all.length} passed${failed.length > 0 ? ` — ${failed.length} FAILED` : ""}`
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
