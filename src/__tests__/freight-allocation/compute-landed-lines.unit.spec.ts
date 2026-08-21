/**
 * Unit tests for freight allocation bases in `computeLandedLines`.
 *
 * `landed-allocation.ts` is the ONE engine confirming a vendor bill and the
 * store-pos preview both call. Today the freight pool is spread by CBM
 * (`cbm_per_unit × qty`); a line without CBM gets zero. This spec locks the
 * CBM path byte-for-byte (China bills MUST keep producing the exact same
 * numbers) and exercises the two new bases ("units", "value") plus the
 * `unplaceableCents` / `freightCoverage` signals that surface a pool that
 * landed nowhere instead of silently vanishing.
 */

import {
  computeLandedLines,
  type LandedInput,
  type LandedPools,
} from "../../lib/purchase-orders/landed-allocation";

const zeroPools = (): LandedPools => ({
  commissionCents: 0,
  freightCents: 0,
  tariffCents: 0,
  taxCents: 0,
});

describe("computeLandedLines — freight allocation basis", () => {
  it("1. China regression: no opts === {freightBasis:'cbm'}, byte-for-byte, with hand-computed values", () => {
    const lines: LandedInput[] = [
      { qty: 10, unit_cost_cents: 500, cbm_per_unit: 0.02 }, // weight 0.2
      { qty: 5, unit_cost_cents: 1000, cbm_per_unit: null }, // weight 0 — no CBM
    ];
    const pools: LandedPools = {
      commissionCents: 1000,
      freightCents: 2000,
      tariffCents: 1500,
      taxCents: 0,
    };

    const noOpts = computeLandedLines(lines, pools);
    const explicitCbm = computeLandedLines(lines, pools, {
      freightBasis: "cbm",
    });

    expect(noOpts).toEqual(explicitCbm);

    // Hand-computed expectations (see PR description / scratch math):
    // commission: largest-remainder gives [67, 66] per-unit (Σ = 670+330=1000)
    // freight: all 0.2 CBM-weight is on line 0 → [200, 0] per-unit
    // tariff: value-weighted 5000/5000 → [75, 150] per-unit
    // tax: pool is 0 → [0, 0]
    expect(noOpts.lines).toEqual([
      {
        commission_per_unit_cents: 67,
        freight_per_unit_cents: 200,
        tariff_per_unit_cents: 75,
        tax_per_unit_cents: 0,
        landed_unit_cost_cents: 500 + 67 + 200 + 75 + 0,
        landed_total_cents: 5000 + 667 + 2000 + 750 + 0,
      },
      {
        commission_per_unit_cents: 66,
        freight_per_unit_cents: 0,
        tariff_per_unit_cents: 150,
        tax_per_unit_cents: 0,
        landed_unit_cost_cents: 1000 + 66 + 0 + 150 + 0,
        landed_total_cents: 5000 + 333 + 0 + 750 + 0,
      },
    ]);
    expect(noOpts.residualCents).toEqual({
      commission: 0,
      freight: 0,
      tariff: 0,
      tax: 0,
    });
    expect(noOpts.unplaceableCents).toEqual({
      commission: 0,
      freight: 0,
      tariff: 0,
      tax: 0,
    });
    expect(noOpts.freightCoverage).toEqual({
      linesWithCbm: 1,
      linesTotal: 2,
      complete: false,
    });
  });

  it.each<["cbm" | "units" | "value", LandedInput[]]>([
    [
      "cbm",
      [
        { qty: 4, unit_cost_cents: 1000, cbm_per_unit: 0.05 },
        { qty: 6, unit_cost_cents: 2000, cbm_per_unit: 0.03 },
      ],
    ],
    [
      "units",
      [
        { qty: 2, unit_cost_cents: 700, cbm_per_unit: null },
        { qty: 3, unit_cost_cents: 900, cbm_per_unit: null },
      ],
    ],
    [
      "value",
      [
        { qty: 7, unit_cost_cents: 350, cbm_per_unit: null },
        { qty: 2, unit_cost_cents: 1250, cbm_per_unit: null },
      ],
    ],
  ])(
    "2. basis %s: Σ freightTotals + unplaceableCents.freight === pools.freightCents",
    (basis, lines) => {
      const pools: LandedPools = { ...zeroPools(), freightCents: 777 };
      const result = computeLandedLines(lines, pools, {
        freightBasis: basis,
      });

      // With commission/tariff/tax pools at 0, landed_total_cents per line
      // is exactly unit_cost*qty + its freight line-total share.
      const goodsTotal = lines.reduce(
        (s, l) => s + l.unit_cost_cents * l.qty,
        0
      );
      const landedTotal = result.lines.reduce(
        (s, l) => s + l.landed_total_cents,
        0
      );
      const placedFreight = landedTotal - goodsTotal;

      expect(placedFreight + result.unplaceableCents.freight).toBe(777);
    }
  );

  it("3. bill 100% without CBM, freight > 0: basis 'cbm' strands the whole pool, basis 'units' places it all", () => {
    const lines: LandedInput[] = [
      { qty: 3, unit_cost_cents: 100, cbm_per_unit: null },
      { qty: 5, unit_cost_cents: 200, cbm_per_unit: null },
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 4000 };

    const cbmResult = computeLandedLines(lines, pools, {
      freightBasis: "cbm",
    });
    expect(cbmResult.unplaceableCents.freight).toBe(4000);
    expect(cbmResult.lines.every((l) => l.freight_per_unit_cents === 0)).toBe(
      true
    );
    expect(cbmResult.freightCoverage).toEqual({
      linesWithCbm: 0,
      linesTotal: 2,
      complete: false,
    });

    const unitsResult = computeLandedLines(lines, pools, {
      freightBasis: "units",
    });
    expect(unitsResult.unplaceableCents.freight).toBe(0);
    const goodsTotal = lines.reduce((s, l) => s + l.unit_cost_cents * l.qty, 0);
    const landedTotal = unitsResult.lines.reduce(
      (s, l) => s + l.landed_total_cents,
      0
    );
    expect(landedTotal - goodsTotal).toBe(4000);
  });

  it("4. mixed lines, basis 'cbm': lines without CBM get 0 freight and the CBM lines absorb everything — this is the KNOWN LATENT BUG (see spec), fixed operationally by switching the bill to basis 'units', not by this test", () => {
    const lines: LandedInput[] = [
      { qty: 4, unit_cost_cents: 100, cbm_per_unit: 0.1 }, // has CBM
      { qty: 6, unit_cost_cents: 200, cbm_per_unit: null }, // no CBM
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 1000 };

    const result = computeLandedLines(lines, pools, { freightBasis: "cbm" });

    expect(result.lines[1]?.freight_per_unit_cents).toBe(0);
    expect(result.lines[1]?.landed_total_cents).toBe(200 * 6); // no freight share at all
    expect(result.lines[0]?.freight_per_unit_cents).toBeGreaterThan(0);
    // The whole pool landed on line 0 (goods 400 + freight 1000 = 1400)
    expect(result.lines[0]?.landed_total_cents).toBe(400 + 1000);
    expect(result.freightCoverage.complete).toBe(false);
    // Not "unplaceable" — SOME weight exists (line 0's CBM), so the pool did
    // land somewhere. This is exactly the silent-skew case a bill owner needs
    // to notice via freightCoverage, not via unplaceableCents.
    expect(result.unplaceableCents.freight).toBe(0);
  });

  it("5. basis 'value' with ALL lines at cost 0 and freight > 0: whole pool unplaceable, no divide-by-zero / NaN", () => {
    const lines: LandedInput[] = [
      { qty: 2, unit_cost_cents: 0, cbm_per_unit: null },
      { qty: 5, unit_cost_cents: 0, cbm_per_unit: null },
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 900 };

    const result = computeLandedLines(lines, pools, {
      freightBasis: "value",
    });

    expect(result.unplaceableCents.freight).toBe(900);
    for (const line of result.lines) {
      expect(line.freight_per_unit_cents).toBe(0);
      expect(Number.isNaN(line.freight_per_unit_cents)).toBe(false);
      expect(Number.isNaN(line.landed_total_cents)).toBe(false);
      expect(Number.isNaN(line.landed_unit_cost_cents)).toBe(false);
    }
  });

  it("7. basis 'units', pool smaller than EVERY line's qty (VB-1124, 2026-08-21): the per-unit allocator can't place a single +1¢/unit bump anywhere, so before the fix the whole pool vanished from landed_unit_cost_cents — now it lands on the highest-value line instead. landed_total_cents (the AVCO/QB numerator) was always exact and stays exact.", () => {
    const lines: LandedInput[] = [
      { qty: 500, unit_cost_cents: 11, cbm_per_unit: null },
      { qty: 1000, unit_cost_cents: 24, cbm_per_unit: null },
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 297 };

    const result = computeLandedLines(lines, pools, { freightBasis: "units" });

    // Not "unplaceable" — both lines have positive weight (qty). This is the
    // residual case: the pool has money to place, but no line's qty (500,
    // 1000) is small enough to receive a whole +1¢/unit bump for a 297¢ pool.
    expect(result.unplaceableCents.freight).toBe(0);
    expect(result.residualCents.freight).toBe(297);

    // The lower-value line (500 × 11¢ = 5500) gets nothing, same as before
    // this fix — it was never the line the residual was assigned to.
    expect(result.lines[0]?.freight_per_unit_cents).toBe(0);
    expect(result.lines[0]?.landed_unit_cost_cents).toBe(11);

    // The higher-value line (1000 × 24¢ = 24000) absorbs the whole pool as a
    // single lump per-unit bump: ceil(297 / 1000) = 1.
    expect(result.lines[1]?.freight_per_unit_cents).toBe(1);
    expect(result.lines[1]?.landed_unit_cost_cents).toBe(25);

    // landed_total_cents is untouched by this fix — allocateLineTotalsCents
    // already placed the pool exactly, with no residual, before and after.
    expect(result.lines[0]?.landed_total_cents).toBe(500 * 11 + 99);
    expect(result.lines[1]?.landed_total_cents).toBe(1000 * 24 + 198);
    const landedTotal = result.lines.reduce((s, l) => s + l.landed_total_cents, 0);
    const goodsTotal = lines.reduce((s, l) => s + l.unit_cost_cents * l.qty, 0);
    expect(landedTotal - goodsTotal).toBe(297);
  });

  it("8. basis 'units', single product line (VB-1122, 2026-08-21): the only line absorbs its own residual — before the fix landed_unit_cost_cents floored to 15, silently dropping 9.96 of the 24.96 pool actually owed", () => {
    const lines: LandedInput[] = [
      { qty: 1500, unit_cost_cents: 14, cbm_per_unit: null },
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 2496 };

    const result = computeLandedLines(lines, pools, { freightBasis: "units" });

    expect(result.unplaceableCents.freight).toBe(0);
    // floor(2496/1500) = 1 per unit (1500¢ placed), residual = 996¢ — this is
    // the $9.96 that used to be silently dropped from landed_unit_cost_cents.
    expect(result.residualCents.freight).toBe(996);
    // ceil(996/1500) = 1 extra ¢/unit on top of the 1 already placed.
    expect(result.lines[0]?.freight_per_unit_cents).toBe(2);
    expect(result.lines[0]?.landed_unit_cost_cents).toBe(16);
    // landed_total_cents was exact before and after: 1500×14 + 2496.
    expect(result.lines[0]?.landed_total_cents).toBe(1500 * 14 + 2496);
  });

  it("6. basis 'units', owner's example: SKU1 qty 2, SKU2 qty 3, freight 5000 cents → exactly 2000 and 3000", () => {
    const lines: LandedInput[] = [
      { qty: 2, unit_cost_cents: 0, cbm_per_unit: null }, // SKU1
      { qty: 3, unit_cost_cents: 0, cbm_per_unit: null }, // SKU2
    ];
    const pools: LandedPools = { ...zeroPools(), freightCents: 5000 };

    const result = computeLandedLines(lines, pools, {
      freightBasis: "units",
    });

    expect(result.lines[0]?.landed_total_cents).toBe(2000);
    expect(result.lines[1]?.landed_total_cents).toBe(3000);
    expect(result.lines[0]?.freight_per_unit_cents).toBe(1000);
    expect(result.lines[1]?.freight_per_unit_cents).toBe(1000);
    expect(result.unplaceableCents.freight).toBe(0);
  });
});
