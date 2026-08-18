/**
 * The shared 5-decimal `<Cost>` truncation guard
 * (qb-vendor-bill-cost-truncation-guard.ts), tested directly and decoupled
 * from the DB-driven Add/Mod enqueue functions.
 *
 * Why decoupled: in BOTH `qb-vendor-bill-enqueue.ts` and
 * `qb-vendor-bill-mod-enqueue.ts`, a product line's `amount_cents` is built
 * from the EXACT SAME arithmetic the drift check itself uses
 * (`unit_cost_cents * qty + tax_share_cents + freight_share_cents`) — every
 * input the DB can realistically hand back is a defined number, so under
 * real data `amount_cents` can never fail to be finite while the drift is
 * still computable. That coupling is exactly why the guard's blocking case
 * disappears once `<Amount>` ships (the fix this file's sibling,
 * `mod-cost-truncation.unit.spec.ts`, now asserts) — but it also means the
 * "a line lacks `amount_cents`" branch cannot be reached by driving the full
 * enqueue functions with any DB fixture. Testing the shared pure functions
 * directly, with a deliberately mismatched line (no `amount_cents`, but a
 * real non-round-tripping cost/tax/freight combination), is what actually
 * proves the guard still bites when the field is genuinely missing.
 */

import {
  allLinesCarryAmount,
  costTruncationDriftCents,
  type CostTruncationLine,
} from "../../lib/purchase-orders/qb-vendor-bill-cost-truncation-guard";

describe("qb-vendor-bill-cost-truncation-guard", () => {
  describe("allLinesCarryAmount", () => {
    it("true when every line's amount_cents is a finite number", () => {
      const lines: CostTruncationLine[] = [
        {
          qty: 2000,
          unit_cost_cents: 1000,
          tax_share_cents: 0,
          freight_share_cents: 33,
          amount_cents: 2_000_033,
        },
      ];
      expect(allLinesCarryAmount(lines)).toBe(true);
    });

    it("false when ANY line's amount_cents is missing (NaN/undefined) — the pre-migration shape", () => {
      const lines: CostTruncationLine[] = [
        {
          qty: 2000,
          unit_cost_cents: 1000,
          tax_share_cents: 0,
          freight_share_cents: 33,
          amount_cents: 2_000_033,
        },
        {
          qty: 5,
          unit_cost_cents: 500,
          tax_share_cents: 0,
          freight_share_cents: 0,
          // undefined ~ what a payload built without the Amount migration
          // (or a future path that stops setting it) would carry.
          amount_cents: undefined as unknown as number,
        },
      ];
      expect(allLinesCarryAmount(lines)).toBe(false);
    });
  });

  describe("costTruncationDriftCents", () => {
    it("is zero for a cost that round-trips through 5-decimal <Cost> exactly", () => {
      // 2 units @ $10.00 + $5.00 freight → $7.50/unit, terminates cleanly.
      const lines: CostTruncationLine[] = [
        {
          qty: 2,
          unit_cost_cents: 1000,
          tax_share_cents: 0,
          freight_share_cents: 500,
          amount_cents: 2500,
        },
      ];
      expect(costTruncationDriftCents(lines)).toBe(0);
    });

    it("is non-zero for the same non-round-tripping fixture the Mod spec used to reject unconditionally", () => {
      // qty 2000 @ $10.00 + $0.33 freight — 2,000,033 / 2000 / 100 =
      // $10.000165, truncated to 5 decimals loses the fraction: round-tripped
      // back through quantity × truncated cost lands one cent short.
      const lines: CostTruncationLine[] = [
        {
          qty: 2000,
          unit_cost_cents: 1000,
          tax_share_cents: 0,
          freight_share_cents: 33,
          amount_cents: 2_000_033,
        },
      ];
      expect(costTruncationDriftCents(lines)).toBeGreaterThan(0);
    });
  });

  describe("guard still bites: a line without amount_cents, on a total that genuinely does not round-trip", () => {
    it("allLinesCarryAmount is false AND the drift is real — the exact scenario the guard exists to catch", () => {
      const lines: CostTruncationLine[] = [
        {
          qty: 2000,
          unit_cost_cents: 1000,
          tax_share_cents: 0,
          freight_share_cents: 33,
          amount_cents: undefined as unknown as number,
        },
      ];
      expect(allLinesCarryAmount(lines)).toBe(false);
      const drift = costTruncationDriftCents(lines);
      expect(drift).toBeGreaterThan(0);
      // This is what the caller does: skip the check when every line carries
      // amount_cents; otherwise run it, and reject on drift > 0.
      const wouldReject = !allLinesCarryAmount(lines) && drift > 0;
      expect(wouldReject).toBe(true);
    });
  });
});
