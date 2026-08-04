/**
 * These lines decide how much A/P a QuickBooks bill posts. Getting them wrong
 * does not fail loudly — it posts a normal-looking document with the wrong
 * balance — so the cases below are anchored to the REAL lines VB-1059 carried
 * before its rebuild deleted them.
 */
import {
  clearingTotalCents,
  deriveClearingDrift,
  deriveClearingLines,
  type ClearingSibling,
} from "../../lib/purchase-orders/qb-vendor-bill-clearing-lines";

// The two siblings of VB-1059 (PO-1110, Shenzhen Veetech), with the accounts
// and amounts read from production on 2026-08-04.
const FREIGHT: ClearingSibling = {
  vendor_bill_id: "vb_freight",
  number: "VB-1060",
  bill_type: "freight",
  qb_account_list_id: "8000006A-1361379664",
  qb_account_full_name: "Freight and Shipping Costs",
  total_cents: 85400,
};
const COMMISSION: ClearingSibling = {
  vendor_bill_id: "vb_service",
  number: "VB-1061",
  bill_type: "service",
  qb_account_list_id: "80000185-1757423159",
  qb_account_full_name: "Commission for Purchase:Veetech Representative",
  total_cents: 34643,
};

describe("deriveClearingLines", () => {
  it("reproduces the shape QuickBooks actually held on VB-1059", () => {
    const out = deriveClearingLines([FREIGHT, COMMISSION]);
    if (!out.ok) throw new Error(out.reason);

    expect(out.lines).toEqual([
      {
        kind: "freight",
        account_list_id: "8000006A-1361379664",
        account_full_name: "Freight and Shipping Costs",
        amount_cents: -85400,
        vendor_bill_id: "vb_freight",
      },
      {
        // NOT "service": the line QuickBooks carried was tagged `commission`,
        // and the Mod reproduces what the Add sent.
        kind: "commission",
        account_list_id: "80000185-1757423159",
        account_full_name: "Commission for Purchase:Veetech Representative",
        amount_cents: -34643,
        vendor_bill_id: "vb_service",
      },
    ]);
  });

  it("uses the sibling's CURRENT amount, not whatever QuickBooks was told before", () => {
    // QuickBooks held -328.60 from July; VB-1061 is $346.43 today. Rebuilding
    // with the current figure is what settles that drift.
    const out = deriveClearingLines([COMMISSION]);
    if (!out.ok) throw new Error(out.reason);
    expect(out.lines[0].amount_cents).toBe(-34643);
    expect(out.lines[0].amount_cents).not.toBe(-32860);
  });

  it("refuses to build a line for a sibling with no QuickBooks account", () => {
    // Dropping it would understate the clearing and overstate A/P by exactly
    // that sibling's amount — on a document that looks entirely normal.
    const out = deriveClearingLines([
      { ...FREIGHT, qb_account_list_id: null },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.reason).toContain("854.00");
  });

  it("refuses a negative sibling total — that would ADD to A/P", () => {
    const out = deriveClearingLines([{ ...FREIGHT, total_cents: -100 }]);
    expect(out.ok).toBe(false);
  });

  it("skips a zero sibling instead of posting an empty row", () => {
    const out = deriveClearingLines([{ ...FREIGHT, total_cents: 0 }, COMMISSION]);
    if (!out.ok) throw new Error(out.reason);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].kind).toBe("commission");
  });

  it("returns nothing when there are no siblings — a plain bill needs no clearing", () => {
    const out = deriveClearingLines([]);
    if (!out.ok) throw new Error(out.reason);
    expect(out.lines).toEqual([]);
  });

  it("totals what is removed from A/P, so the caller can check its own arithmetic", () => {
    const out = deriveClearingLines([FREIGHT, COMMISSION]);
    if (!out.ok) throw new Error(out.reason);
    // $854.00 + $346.43 — the exact amount VB-1060 and VB-1061 have been
    // sitting uncancelled in A/P since the rebuild deleted VB-1059.
    expect(clearingTotalCents(out.lines)).toBe(120043);
  });
});

/**
 * The drift the banner reports. Anchored to the one bill that was ALREADY in
 * this state when the check was written: VB-1053 cancels $564.51 in QuickBooks
 * while its commission sibling VB-1054 is $566.27 today.
 */
describe("deriveClearingDrift", () => {
  const VB_1054: ClearingSibling = {
    vendor_bill_id: "vb_1054",
    number: "VB-1054",
    bill_type: "service",
    qb_account_list_id: "80000185-1757423159",
    qb_account_full_name: "Commission for Purchase:Veetech Representative",
    total_cents: 56627,
  };
  const VB_1055: ClearingSibling = {
    vendor_bill_id: "vb_1055",
    number: "VB-1055",
    bill_type: "freight",
    qb_account_list_id: "8000006A-1361379664",
    qb_account_full_name: "Freight and Shipping Costs",
    total_cents: 126800,
  };
  // As persisted — NEGATIVE, which is how both the Add and the July backfill
  // write them.
  const AS_HELD_BY_QB = [
    { kind: "commission" as const, amount_cents: -56451 },
    { kind: "freight" as const, amount_cents: -126800 },
  ];

  it("finds the $1.76 VB-1053 has been off by since July", () => {
    const drift = deriveClearingDrift(AS_HELD_BY_QB, [VB_1054, VB_1055]);
    expect(drift.stale).toBe(true);
    expect(drift.delta_cents).toBe(176);
    expect(drift.items).toEqual([
      {
        kind: "commission",
        number: "VB-1054",
        quickbooks_cents: 56451,
        current_cents: 56627,
      },
    ]);
    // The freight matches to the cent and must not be reported — a banner that
    // lists a line that is fine teaches the operator to skip the banner.
    expect(drift.items).toHaveLength(1);
  });

  it("says nothing when both sides agree", () => {
    const drift = deriveClearingDrift(
      [
        { kind: "commission", amount_cents: -56627 },
        { kind: "freight", amount_cents: -126800 },
      ],
      [VB_1054, VB_1055]
    );
    expect(drift.stale).toBe(false);
    expect(drift.delta_cents).toBe(0);
  });

  it("reads the stored sign as a magnitude, not as an amount", () => {
    // Sign is a convention of how the line is WRITTEN; both sides mean the same
    // money. Comparing -56627 against 56627 would report every line as adrift.
    const drift = deriveClearingDrift(
      [{ kind: "commission", amount_cents: 56627 }],
      [VB_1054]
    );
    expect(drift.stale).toBe(false);
  });

  it("reports a sibling QuickBooks has never seen", () => {
    // VB-1059, VB-1070 and VB-1073: linked siblings, no clearing lines over
    // there at all. A/P is overstated by the whole sibling, not by a delta.
    const drift = deriveClearingDrift([], [VB_1054]);
    expect(drift.items).toEqual([
      {
        kind: "commission",
        number: "VB-1054",
        quickbooks_cents: 0,
        current_cents: 56627,
      },
    ]);
    expect(drift.delta_cents).toBe(56627);
  });

  it("reports a clearing line whose sibling is gone", () => {
    // Unlinked or deleted after the bill synced: QuickBooks is still cancelling
    // money that no bill explains, so A/P over there is SHORT.
    const drift = deriveClearingDrift(AS_HELD_BY_QB, [VB_1054]);
    expect(drift.items).toContainEqual({
      kind: "freight",
      number: null,
      quickbooks_cents: 126800,
      current_cents: 0,
    });
  });

  it("stays quiet for a bill with no clearing structure at all", () => {
    expect(deriveClearingDrift([], [])).toEqual({
      stale: false,
      delta_cents: 0,
      items: [],
    });
  });
});
