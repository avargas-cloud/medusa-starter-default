/**
 * Verifies that the order total the POS routes patch into `order_summary`
 * matches what QuickBooks bills — using the two documents that were read back
 * from QB over the bridge as the fixtures.
 *
 * Ground truth (read live via /api/sync/direct-query, read-only):
 *
 *   SalesReceipt 27807  (order S10013)
 *     Subtotal 99.98 · SalesTaxPercentage 7.00 · SalesTaxTotal 7.00
 *     TotalAmount 106.98 · one line, SalesTaxCodeRef = Tax
 *
 *   Invoice 18861  (order S10732)
 *     Subtotal 148.99 · SalesTaxTotal 5.25 · payment linked -154.24
 *     lines: product 74.99 → Tax · Services 34.00 → Non · SHIPPING 40.00 → Non
 *
 * Two facts come out of those, and both are what this gate pins:
 *   • QB rounds the tax ONCE over the taxable aggregate. It billed 7.00, not
 *     the 6.9986 that Medusa's per-line arithmetic leaves behind.
 *   • QB honours a per-line exemption. The $34 service was not taxed, so the
 *     tax is 5.25 (7% of 74.99) and not 7.63 (7% of everything).
 *
 * `pos_invoice` already agreed with QB on both. `order_summary` did not, and it
 * is the layer /orders reads — which is why the totals only ever looked wrong
 * in the list and never when the order was opened.
 *
 * Run: cd backend && yarn medusa exec ./src/scripts/verify/verify-order-total-qb-parity.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import {
  resolvePatchedOrderTotal,
  isZeroTaxSafe,
  type TaxLineRewrite,
} from "../../lib/order-money/order-tax-lines";

type TotalCase = {
  name: string;
  netDollars: number;
  taxableNetDollars: number;
  shippingDollars: number;
  /** adjustments already inside netDollars (0 unless the case tests discounts) */
  adjustmentsDollars?: number;
  /** per-line discount already baked into unit_price */
  bakedDiscountDollars?: number;
  posTaxAmount: number;
  discount: number;
  /** null = the route must REFUSE to write */
  expectedTotal: number | null;
  why: string;
};

const CASES: TotalCase[] = [
  {
    name: "S10013 / SR 27807 — one taxable line",
    netDollars: 99.98,
    taxableNetDollars: 99.98,
    shippingDollars: 0,
    posTaxAmount: 7.0,
    discount: 0,
    expectedTotal: 106.98,
    why: "QuickBooks billed 106.98; the old formula stored 113.9786 — a whole second tax",
  },
  {
    name: "S10255 — discount BAKED into unit_price, must not be subtracted twice",
    netDollars: 4741.1, // net line prices, the 10% already inside them
    taxableNetDollars: 3441.1,
    shippingDollars: 0,
    bakedDiscountDollars: 299.53, // what the baked 10% already removed
    posTaxAmount: 240.88,
    discount: 299.08, // the POS announces the same discount again
    expectedTotal: 4981.98, // 4741.10 + tax, NOT 4741.10 - 299.08 + tax
    why: "the base already carries this discount; subtracting the caller's copy would charge it twice",
  },
  {
    name: "E2606 — per-line discount baked AND a separate order discount",
    netDollars: 2838.16, // net lines (35% baked) minus the 15.99 adjustment
    taxableNetDollars: 2838.16,
    shippingDollars: 0,
    adjustmentsDollars: 15.99,
    bakedDiscountDollars: 1537.07,
    posTaxAmount: 198.67,
    discount: 15.99,
    expectedTotal: 3036.83,
    why: "matches the POS to the cent; a gross-based base overstated this order by $1,338.40",
  },
  {
    name: "S10732 / Invoice 18861 — taxable + exempt + shipping",
    netDollars: 108.99, // 74.99 taxable + 34.00 exempt service
    taxableNetDollars: 74.99,
    shippingDollars: 40.0,
    posTaxAmount: 5.25, // 7% of 74.99 only
    discount: 0,
    expectedTotal: 154.24,
    why: "QuickBooks billed 154.24; order_summary held 156.6193 by taxing the exempt $34 service",
  },
  {
    name: "S11240 — the group that already read correctly",
    netDollars: 3299.9,
    taxableNetDollars: 3299.9,
    shippingDollars: 0,
    posTaxAmount: 230.99,
    discount: 0,
    expectedTotal: 3530.89,
    why: "must stay unchanged — these 7 orders were never wrong",
  },
  {
    name: "E2542 (sandbox) — the case that caught the first fix being wrong",
    netDollars: 2580.0, // 2250 taxable + 330 exempt INSTALL
    taxableNetDollars: 2250.0,
    shippingDollars: 0,
    posTaxAmount: 157.5,
    discount: 0,
    expectedTotal: 2737.5,
    why: "subtracting an 'embedded' tax that was held separately produced 2580.00 — a total with NO tax",
  },
  {
    name: "order discount already inside the line adjustments → subtract ONCE",
    netDollars: 180, // 200 gross - 20 distributed into line adjustments
    taxableNetDollars: 180,
    shippingDollars: 0,
    adjustmentsDollars: 20, // the SAME $20, already out of netDollars
    posTaxAmount: 12.6,
    discount: 20, // caller passes it again as pos_discount_amount
    expectedTotal: 192.6,
    why: "Codex caught this: Medusa distributes order discounts into line adjustments, so subtracting the caller's figure too stored 172.60",
  },
  {
    name: "discount larger than the order → refuse (group B shape)",
    netDollars: 500.23,
    taxableNetDollars: 500.23,
    shippingDollars: 0,
    posTaxAmount: 0,
    discount: 500.23 + 42,
    expectedTotal: null,
    why: "six orders hold a stored total of ~$0 against a real value (S10619: 500.23 → 0.00), which poisons the deposit clamp",
  },
  {
    name: "legitimate full discount → allowed",
    netDollars: 100,
    taxableNetDollars: 100,
    shippingDollars: 0,
    posTaxAmount: 0,
    discount: 100,
    expectedTotal: 0,
    why: "a discount equal to the order is not the bug; only one that EXCEEDS it is",
  },
  {
    name: "negative line net → refuse",
    netDollars: -5,
    taxableNetDollars: 0,
    shippingDollars: 0,
    posTaxAmount: 0,
    discount: 0,
    expectedTotal: null,
    why: "an order is not worth a negative amount; writing one poisons the clamp",
  },
];

export default async function verifyOrderTotalQbParity({ logger }: ExecArgs) {
  const log = (m: string) => (logger ? logger.info(m) : console.log(m));
  let failures = 0;

  log("\n── 1. patched order total vs what QuickBooks bills ──");
  for (const c of CASES) {
    const r = resolvePatchedOrderTotal({
      base: {
        netDollars: c.netDollars,
        taxableNetDollars: c.taxableNetDollars,
        shippingDollars: c.shippingDollars,
        adjustmentsDollars: c.adjustmentsDollars ?? 0,
        bakedDiscountDollars: c.bakedDiscountDollars ?? 0,
      },
      posTaxAmount: c.posTaxAmount,
      discount: c.discount,
    });
    const got = r.ok ? r.total : null;
    const ok = got === c.expectedTotal;
    if (!ok) failures++;
    log(
      `  ${ok ? "PASS" : "FAIL"}  ${c.name}\n` +
        `        → ${got === null ? `REFUSED (${(r as any).reason ?? ""})` : `$${got.toFixed(2)}`}` +
        ` (expected ${c.expectedTotal === null ? "REFUSED" : `$${c.expectedTotal.toFixed(2)}`})\n` +
        `        ${c.why}`
    );
  }

  // Medusa accumulates the tax per line and leaves the decimals hanging;
  // QuickBooks rounds the taxable base to the cent. Because
  // Σ(lineᵢ × rate) === (Σlineᵢ) × rate, rounding the aggregate once lands on
  // QB's figure exactly — this is what convert-force now does to liveTaxTotal.
  log("\n── 2. rounding the aggregate reproduces QB's cent ──");
  const medusaPerLine = 99.98 * 0.07; // 6.9986
  const rounded = Math.round(medusaPerLine * 100) / 100;
  const roundOk = rounded === 7.0;
  if (!roundOk) failures++;
  log(
    `  ${roundOk ? "PASS" : "FAIL"}  99.98 @ 7% → Medusa ${medusaPerLine} → rounded ${rounded} ` +
      `(QB SalesTaxTotal on SR 27807 = 7.00)`
  );

  // tax_total is not display-only: the QB handlers pick the document's header
  // tax code with `hasTax = order.tax_total > 0`, so writing 0 on an order that
  // still has taxable lines sends the header as Exempt and QuickBooks then
  // charges nothing on ANY line, whatever the per-line codes say.
  log("\n── 3. tax_total = 0 is only safe when nothing is taxable ──");
  const allExempt: TaxLineRewrite = {
    itemIds: ["a", "b"],
    taxedItemIds: [],
    exemptItemIds: ["a", "b"],
  };
  const someTaxed: TaxLineRewrite = {
    itemIds: ["a", "b"],
    taxedItemIds: ["a"],
    exemptItemIds: ["b"],
  };
  const zeroChecks: Array<[string, boolean, boolean]> = [
    ["every line exempt → zero is safe", isZeroTaxSafe(allExempt), true],
    ["one line taxable → zero is NOT safe", isZeroTaxSafe(someTaxed), false],
  ];
  for (const [label, got, want] of zeroChecks) {
    const ok = got === want;
    if (!ok) failures++;
    log(`  ${ok ? "PASS" : "FAIL"}  ${label} (got ${got})`);
  }

  log(
    failures === 0
      ? "\n✅ the patched order total matches QuickBooks on every measured shape\n"
      : `\n❌ ${failures} check(s) failed — the stored order total does not match what QB bills\n`
  );
  if (failures > 0) process.exitCode = 1;
}
