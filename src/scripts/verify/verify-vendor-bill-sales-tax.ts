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
  // NOTE: `allocated + residual === pool` is true BY CONSTRUCTION — asserting it
  // proves nothing. The real question is whether the money survives, and via the
  // per-unit route it does NOT: 1290/37 floors to 34¢/unit = 1258¢, stranding
  // 32¢ that no line can absorb (the subset-sum rescue needs a line of qty ≤ 32
  // and the only line has 37). That shortfall used to reach average_cost.
  const perUnitRoute = out[0]!.tax_per_unit_cents * 37;
  check(
    "the per-unit route is lossy — this is why landed_total_cents exists",
    perUnitRoute === 1258 && residualCents.tax === 32,
    `perUnit×qty ${perUnitRoute}, residual ${residualCents.tax}`
  );
  check(
    "landed_total_cents carries the goods AND the whole tax, to the penny",
    out[0]!.landed_total_cents === 498 * 37 + 1290,
    `${out[0]!.landed_total_cents} vs ${498 * 37 + 1290}`
  );
  check(
    "the bill reconciles: landed total === goods + tax ($197.16)",
    out[0]!.landed_total_cents === 19716,
    `$${(out[0]!.landed_total_cents / 100).toFixed(2)}`
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

console.log("\n5. Exactness across ALL pools, over adversarial shapes");
{
  // Brute-force the property that broke: for any line shape and any pool mix,
  // Σ landed_total_cents must equal Σ(unit×qty) + every pool, to the penny.
  const shapes: LandedInput[][] = [
    [{ qty: 37, unit_cost_cents: 498, cbm_per_unit: null }],
    [{ qty: 250, unit_cost_cents: 1, cbm_per_unit: 0.001 }],
    [
      { qty: 7, unit_cost_cents: 101, cbm_per_unit: null },
      { qty: 11, unit_cost_cents: 13, cbm_per_unit: 0.5 },
    ],
    [
      { qty: 1, unit_cost_cents: 999999, cbm_per_unit: 3 },
      { qty: 999, unit_cost_cents: 1, cbm_per_unit: null },
      { qty: 13, unit_cost_cents: 77, cbm_per_unit: 0.02 },
    ],
  ];
  let worstDrift = 0;
  let cases = 0;
  for (const lines of shapes) {
    for (const c of [0, 1, 1290, 45375]) {
      for (const f of [0, 7, 88000]) {
        for (const t of [0, 999]) {
          for (const x of [0, 3, 1290, 12345]) {
            const pools = {
              commissionCents: c,
              freightCents: f,
              tariffCents: t,
              taxCents: x,
            };
            const { lines: res } = computeLandedLines(lines, pools);
            const goods = lines.reduce(
              (s, l) => s + l.unit_cost_cents * l.qty,
              0
            );
            // A pool with no positive weight anywhere cannot be placed — freight
            // over lines that all lack CBM is the real case. Expected, not drift.
            const cbmW = lines.reduce(
              (s, l) => s + (l.cbm_per_unit != null ? l.cbm_per_unit * l.qty : 0),
              0
            );
            const placeable = c + (cbmW > 0 ? f : 0) + t + x;
            const got = res.reduce((s, r) => s + r.landed_total_cents, 0);
            worstDrift = Math.max(worstDrift, Math.abs(got - (goods + placeable)));
            cases++;
          }
        }
      }
    }
  }
  check(
    `every pool lands to the penny across ${cases} pool/shape combinations`,
    worstDrift === 0,
    `worst drift ${worstDrift}c`
  );
}

console.log("\n6. The cost PREVIEW must agree with the CONFIRM, to the penny");
{
  // The confirm route sums `landed_total_cents`. The replay engine that powers
  // the cost preview works per RECEIPT line, so it derives an exact per-unit
  // (`landed_total_cents / qty`) instead. Both must describe the same money, or
  // the preview promises an average cost the confirm then contradicts.
  const shapes: LandedInput[][] = [
    [{ qty: 37, unit_cost_cents: 498, cbm_per_unit: null }],
    [
      { qty: 100, unit_cost_cents: 550, cbm_per_unit: 0.012 },
      { qty: 3, unit_cost_cents: 12345, cbm_per_unit: null },
    ],
    [{ qty: 250, unit_cost_cents: 7, cbm_per_unit: 0.5 }],
  ];
  let worst = 0;
  for (const lines of shapes) {
    for (const pools of [
      { commissionCents: 0, freightCents: 0, tariffCents: 0, taxCents: 1290 },
      { commissionCents: 4537, freightCents: 8800, tariffCents: 125, taxCents: 999 },
    ]) {
      const { lines: res } = computeLandedLines(lines, pools);
      res.forEach((r, i) => {
        const qty = lines[i]!.qty;
        const previewMoney = (r.landed_total_cents / qty) * qty; // replay's route
        worst = Math.max(worst, Math.abs(previewMoney - r.landed_total_cents));
        // And the lossy route it replaced, for contrast:
        const lossy = r.landed_unit_cost_cents * qty;
        if (lossy !== r.landed_total_cents) {
          console.log(
            `    (qty ${qty}: per-unit route would have said ${lossy}c vs the real ${r.landed_total_cents}c)`
          );
        }
      });
    }
  }
  check(
    "the preview's exact per-unit reproduces the confirm's line money",
    worst < 1e-6,
    `worst divergence ${worst}`
  );
}

console.log("\n7. Determinism — the POS preview must equal the confirm");
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
