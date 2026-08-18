/**
 * Unit tests for `resolveFreightPolicy` (lib/purchase-orders/freight-policy.ts).
 *
 * Pure function — the ONE place that decides whether a bill's
 * `freight_charge` line(s) stay a pure ExpenseLine (legacy, NULL basis) or
 * get capitalized into the landed item cost (non-null basis). The confirm
 * route and both QB payload builders (ADD + MOD) all call this, so its
 * contract has to be locked here rather than re-derived per caller.
 */

import { resolveFreightPolicy } from "../../lib/purchase-orders/freight-policy";

describe("resolveFreightPolicy", () => {
  it("NULL basis → legacy, regardless of freight_charge lines or header amount", () => {
    expect(
      resolveFreightPolicy({
        freightAllocationBasis: null,
        freightChargeLineAmountsCents: [854, 10898],
        headerFreightAmountCents: 0,
      })
    ).toEqual({ mode: "legacy" });
  });

  it("non-null basis sums the freight_charge line amounts into poolCents", () => {
    expect(
      resolveFreightPolicy({
        freightAllocationBasis: "units",
        freightChargeLineAmountsCents: [500, 300, 200],
        headerFreightAmountCents: 0,
      })
    ).toEqual({ mode: "capitalized", basis: "units", poolCents: 1000 });
  });

  it("non-null basis with ZERO freight_charge lines → capitalized with an empty pool (not an error)", () => {
    expect(
      resolveFreightPolicy({
        freightAllocationBasis: "value",
        freightChargeLineAmountsCents: [],
        headerFreightAmountCents: 0,
      })
    ).toEqual({ mode: "capitalized", basis: "value", poolCents: 0 });
  });

  it("throws when a non-null basis coexists with a positive header freight pool (double-count guard)", () => {
    expect(() =>
      resolveFreightPolicy({
        freightAllocationBasis: "cbm",
        freightChargeLineAmountsCents: [1000],
        headerFreightAmountCents: 500,
      })
    ).toThrow(/double-count|freight_allocation_basis/i);
  });

  it("does NOT throw when the header pool is positive but the basis is NULL (legacy is exactly the header-freight path)", () => {
    expect(() =>
      resolveFreightPolicy({
        freightAllocationBasis: null,
        freightChargeLineAmountsCents: [],
        headerFreightAmountCents: 500,
      })
    ).not.toThrow();
  });

  it("throws on an invalid basis string", () => {
    expect(() =>
      resolveFreightPolicy({
        freightAllocationBasis: "weight",
        freightChargeLineAmountsCents: [100],
        headerFreightAmountCents: 0,
      })
    ).toThrow(/Invalid freight_allocation_basis/);
  });

  it.each(["cbm", "units", "value"] as const)(
    "accepts basis '%s'",
    (basis) => {
      expect(() =>
        resolveFreightPolicy({
          freightAllocationBasis: basis,
          freightChargeLineAmountsCents: [100],
          headerFreightAmountCents: 0,
        })
      ).not.toThrow();
    }
  );
});
