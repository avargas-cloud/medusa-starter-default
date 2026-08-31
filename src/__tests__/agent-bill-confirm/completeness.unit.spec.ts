/**
 * decideConfirmReceiptRequirement — may this bill be confirmed yet?
 *
 * A China purchasing agent bills the whole purchase order at once, so its bill
 * may only be confirmed after the PO has ARRIVED IN FULL. Everybody else keeps
 * per-shipment confirm, and that negative case is half of what these tests are
 * for: a gate that blocked everyone would break purchasing's daily flow while
 * looking correct on the case it was written for.
 */

import {
  decideConfirmReceiptRequirement,
  type ConfirmReceiptFacts,
} from "../../lib/purchase-orders/po-receipt-completeness";

const facts = (over: Partial<ConfirmReceiptFacts> = {}): ConfirmReceiptFacts => ({
  is_agent_purchase: true,
  has_purchase_order: true,
  qty_ordered: 327,
  qty_received: 327,
  ...over,
});

describe("decideConfirmReceiptRequirement", () => {
  it("blocks an agent bill while units are still outstanding", () => {
    // PO-1153 in production: 327 ordered, 320 received after a line was added.
    const v = decideConfirmReceiptRequirement(facts({ qty_received: 320 }));
    expect(v.satisfied).toBe(false);
    expect(v).toMatchObject({ qty_outstanding: 7 });
    // The operator must know how far off it is without opening the PO.
    expect(v.reason).toContain("320");
    expect(v.reason).toContain("327");
  });

  it("allows an agent bill once the purchase order arrived in full", () => {
    expect(decideConfirmReceiptRequirement(facts()).satisfied).toBe(true);
  });

  it("allows over-receipt — extra units are not a reason to block an invoice", () => {
    expect(
      decideConfirmReceiptRequirement(facts({ qty_received: 330 })).satisfied
    ).toBe(true);
  });

  it("NEVER blocks a non-agent bill, however little arrived", () => {
    // Per-shipment confirm is the daily flow for local vendors: they invoice
    // each delivery. Blocking here would break purchasing, not protect it.
    const v = decideConfirmReceiptRequirement(
      facts({ is_agent_purchase: false, qty_received: 0 })
    );
    expect(v.satisfied).toBe(true);
  });

  it("does not block a bill with no purchase order", () => {
    // A standalone commission has nothing to be complete about.
    const v = decideConfirmReceiptRequirement(
      facts({ has_purchase_order: false, qty_ordered: 0, qty_received: 0 })
    );
    expect(v.satisfied).toBe(true);
  });

  it("treats an agent PO with zero received as blocked, not as complete", () => {
    // 0 >= 0 would be TRUE if the ordered total were also read as 0 — the shape
    // a broken query produces. Ordered must come from the lines.
    const v = decideConfirmReceiptRequirement(
      facts({ qty_ordered: 170, qty_received: 0 })
    );
    expect(v.satisfied).toBe(false);
    expect(v).toMatchObject({ qty_outstanding: 170 });
  });

  it("is decided by the MEASUREMENT, never by a status label", () => {
    // The whole point of measuring: a PO tagged `received` by hand with units
    // outstanding must still be blocked. There is no status input to pass, and
    // that absence IS the assertion — if a status ever enters this signature,
    // this test stops compiling.
    const v = decideConfirmReceiptRequirement(
      facts({ qty_ordered: 100, qty_received: 99 })
    );
    expect(v.satisfied).toBe(false);
  });
});
