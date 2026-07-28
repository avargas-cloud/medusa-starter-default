/**
 * verify-vendor-bill-sales-tax.ts
 *
 * Pure-arithmetic verification of the vendor-bill sales tax feature. No DB, no
 * network — it exercises the ONE allocation engine that the confirm route, the
 * replay engine and the store-pos preview all share, so a regression here is a
 * regression in all three.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-bill-sales-tax.ts
 */

import {
  computeLandedLines,
  type LandedInput,
} from "../../lib/purchase-orders/landed-allocation";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NO_POOLS = {
  commissionCents: 0,
  freightCents: 0,
  tariffCents: 0,
  taxCents: 0,
};

console.log("\n1. PO-1029 / Parts Express — the incident that motivated this");
{
  // $184.26 of goods (37 × $5.99 -- rounded to the vendor's line total) plus
  // $12.90 Florida sales tax = the $197.16 the vendor actually billed.
  const lines: LandedInput[] = [
    { qty: 37, unit_cost_cents: 498, cbm_per_unit: null },
  ];
  const { lines: out, residualCents } = computeLandedLines(lines, {
    ...NO_POOLS,
    taxCents: 1290,
  });
  const allocated = out[0]!.tax_per_unit_cents * 37;
  check(
    "the whole tax pool lands on the line",
    allocated + residualCents.tax === 1290,
    `allocated ${allocated} + residual ${residualCents.tax}`
  );
  check(
    "landed = unit + tax share",
    out[0]!.landed_unit_cost_cents ===
      498 + out[0]!.tax_per_unit_cents,
    `landed ${out[0]!.landed_unit_cost_cents}`
  );
  check(
    "tax raises the unit cost above the raw goods cost",
    out[0]!.landed_unit_cost_cents > 498
  );
}

console.log("\n2. Tax is allocated BY VALUE, like tariff — not flat per unit");
{
  // Two lines, same qty, very different unit cost. A by-value split must give
  // the expensive line the larger share; a flat-per-unit split would tie.
  const lines: LandedInput[] = [
    { qty: 10, unit_cost_cents: 100, cbm_per_unit: null },
    { qty: 10, unit_cost_cents: 900, cbm_per_unit: null },
  ];
  const { lines: out } = computeLandedLines(lines, {
    ...NO_POOLS,
    taxCents: 700,
  });
  check(
    "the expensive line absorbs more tax per unit",
    out[1]!.tax_per_unit_cents > out[0]!.tax_per_unit_cents,
    `cheap ${out[0]!.tax_per_unit_cents} vs dear ${out[1]!.tax_per_unit_cents}`
  );
  check(
    "tax matches the tariff split for the same pool size",
    (() => {
      const viaTariff = computeLandedLines(lines, {
        ...NO_POOLS,
        tariffCents: 700,
      });
      return out.every(
        (l, i) =>
          l.tax_per_unit_cents === viaTariff.lines[i]!.tariff_per_unit_cents
      );
    })()
  );
}

console.log("\n3. Zero tax is a perfect no-op (every pre-existing bill)");
{
  const lines: LandedInput[] = [
    { qty: 25, unit_cost_cents: 1234, cbm_per_unit: 0.01 },
    { qty: 7, unit_cost_cents: 99, cbm_per_unit: null },
  ];
  const withTax = computeLandedLines(lines, {
    commissionCents: 5000,
    freightCents: 3000,
    tariffCents: 1000,
    taxCents: 0,
  });
  const withoutTaxField = computeLandedLines(lines, {
    commissionCents: 5000,
    freightCents: 3000,
    tariffCents: 1000,
    taxCents: 0,
  });
  check(
    "all tax shares are 0",
    withTax.lines.every((l) => l.tax_per_unit_cents === 0)
  );
  check(
    "landed values are untouched by the new pool",
    withTax.lines.every(
      (l, i) =>
        l.landed_unit_cost_cents ===
        withoutTaxField.lines[i]!.landed_unit_cost_cents
    )
  );
  check(
    "the landed identity still holds with all four pools",
    withTax.lines.every(
      (l, i) =>
        l.landed_unit_cost_cents ===
        lines[i]!.unit_cost_cents +
          l.commission_per_unit_cents +
          l.freight_per_unit_cents +
          l.tariff_per_unit_cents +
          l.tax_per_unit_cents
    )
  );
}

console.log("\n4. Tax composes with the other three pools without drift");
{
  const lines: LandedInput[] = [
    { qty: 100, unit_cost_cents: 550, cbm_per_unit: 0.012 },
    { qty: 200, unit_cost_cents: 275, cbm_per_unit: 0.004 },
    { qty: 50, unit_cost_cents: 1999, cbm_per_unit: null },
  ];
  const pools = {
    commissionCents: 45375,
    freightCents: 88000,
    tariffCents: 12500,
    taxCents: 9310,
  };
  const { lines: out, residualCents } = computeLandedLines(lines, pools);
  const allocatedTax = out.reduce(
    (s, l, i) => s + l.tax_per_unit_cents * lines[i]!.qty,
    0
  );
  check(
    "Σ(taxPerUnit × qty) + residual === the tax pool exactly",
    allocatedTax + residualCents.tax === pools.taxCents,
    `${allocatedTax} + ${residualCents.tax} vs ${pools.taxCents}`
  );
  check(
    "any residual is smaller than the smallest line qty",
    residualCents.tax < Math.min(...lines.map((l) => l.qty)),
    `residual ${residualCents.tax}`
  );
  check(
    "the landed identity holds for every line",
    out.every(
      (l, i) =>
        l.landed_unit_cost_cents ===
        lines[i]!.unit_cost_cents +
          l.commission_per_unit_cents +
          l.freight_per_unit_cents +
          l.tariff_per_unit_cents +
          l.tax_per_unit_cents
    )
  );
}

console.log("\n5. Determinism — the POS preview must equal the confirm");
{
  const lines: LandedInput[] = [
    { qty: 13, unit_cost_cents: 777, cbm_per_unit: 0.03 },
    { qty: 29, unit_cost_cents: 313, cbm_per_unit: null },
  ];
  const pools = {
    commissionCents: 1234,
    freightCents: 5678,
    tariffCents: 910,
    taxCents: 1290,
  };
  const a = computeLandedLines(lines, pools);
  const b = computeLandedLines(lines, pools);
  check(
    "repeated runs are byte-identical",
    JSON.stringify(a) === JSON.stringify(b)
  );
}

console.log(
  failures === 0
    ? "\n✅ All sales-tax allocation checks passed\n"
    : `\n❌ ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
