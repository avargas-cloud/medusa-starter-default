/**
 * Unit tests for payment-application-rebind prorate math.
 * Pure functions only — no DB / no container.
 */
import {
  computeProrateRatio,
  computeProrateShare,
} from "../../subscribers/payment-application-rebind.lib";

describe("computeProrateRatio", () => {
  it("returns 1.0 when invoice covers the whole order (single-invoice case)", () => {
    expect(
      computeProrateRatio({
        invoiceTotalCents: 100_000,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 0,
      })
    ).toBe(1);
  });

  it("returns fraction when invoice is partial of order with no siblings", () => {
    // 60% invoice of 100k order, no other invoices.
    expect(
      computeProrateRatio({
        invoiceTotalCents: 60_000,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 0,
      })
    ).toBeCloseTo(0.6, 5);
  });

  it("accounts for sibling invoices when computing remaining capacity", () => {
    // Order = 100k. Sibling invoice already issued 60k. New invoice covers
    // the remaining 40k. Ratio should be 1.0 — this invoice absorbs all
    // remaining dangling applications.
    expect(
      computeProrateRatio({
        invoiceTotalCents: 40_000,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 60_000,
      })
    ).toBe(1);
  });

  it("caps at 1.0 when invoice > remaining capacity (over-invoicing)", () => {
    expect(
      computeProrateRatio({
        invoiceTotalCents: 50_000,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 80_000,
      })
    ).toBe(1);
  });

  it("returns 1.0 fallback when order_total is unknown (zero)", () => {
    expect(
      computeProrateRatio({
        invoiceTotalCents: 50_000,
        orderTotalCents: 0,
        otherInvoicesTotalCents: 0,
      })
    ).toBe(1);
  });

  it("returns 1.0 when invoice_total is zero or negative", () => {
    expect(
      computeProrateRatio({
        invoiceTotalCents: 0,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 0,
      })
    ).toBe(1);
  });

  it("returns 1.0 when capacity already exhausted by other invoices", () => {
    expect(
      computeProrateRatio({
        invoiceTotalCents: 10_000,
        orderTotalCents: 100_000,
        otherInvoicesTotalCents: 100_000,
      })
    ).toBe(1);
  });
});

describe("computeProrateShare", () => {
  it("returns the full amount when ratio is 1.0", () => {
    expect(computeProrateShare(30_000, 1)).toBe(30_000);
  });

  it("computes rounded fractional share", () => {
    expect(computeProrateShare(30_000, 0.6)).toBe(18_000);
  });

  it("rounds half-up consistently", () => {
    expect(computeProrateShare(15_001, 0.5)).toBe(7_501);
    expect(computeProrateShare(15_002, 0.5)).toBe(7_501);
    expect(computeProrateShare(15_003, 0.5)).toBe(7_502);
  });

  it("clamps to 0 when ratio is 0 or negative", () => {
    expect(computeProrateShare(30_000, 0)).toBe(0);
    expect(computeProrateShare(30_000, -0.1)).toBe(0);
  });

  it("returns 0 when application amount is non-positive", () => {
    expect(computeProrateShare(0, 0.5)).toBe(0);
    expect(computeProrateShare(-100, 0.5)).toBe(0);
  });
});

describe("multi-invoice sequential prorate scenario", () => {
  // Scenario from spec:
  //   Order = $1000 (100_000 cents)
  //   Deposit = $300 (30_000 cents) → 1 dangling application
  //   Invoice #1 = $600 (60_000 cents) → ratio = 0.6 → share = 18_000.
  //                                       Remaining dangling = 12_000.
  //   Invoice #2 = $400 (40_000 cents) → ratio = 1.0 (capacity exhausted)
  //                                       → share = 12_000. Full bind.
  it("invoice #1 takes 60% share", () => {
    const ratio = computeProrateRatio({
      invoiceTotalCents: 60_000,
      orderTotalCents: 100_000,
      otherInvoicesTotalCents: 0,
    });
    expect(ratio).toBeCloseTo(0.6, 5);
    expect(computeProrateShare(30_000, ratio)).toBe(18_000);
  });

  it("invoice #2 absorbs the remaining dangling fully", () => {
    const ratio = computeProrateRatio({
      invoiceTotalCents: 40_000,
      orderTotalCents: 100_000,
      otherInvoicesTotalCents: 60_000,
    });
    expect(ratio).toBe(1);
    expect(computeProrateShare(12_000, ratio)).toBe(12_000);
  });
});
