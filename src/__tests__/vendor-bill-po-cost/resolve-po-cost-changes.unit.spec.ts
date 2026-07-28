/**
 * Which PO lines a vendor-bill save is allowed to reprice.
 *
 * This is the gate in front of a write that touches money in three places at
 * once (PO line, PO header totals, QuickBooks PurchaseOrderMod), so the
 * "don't" cases matter more than the "do" case.
 */

import { resolvePoCostChanges } from "../../lib/purchase-orders/po-cost-propagation";

describe("resolvePoCostChanges", () => {
  it("reprices the PO line behind a changed bill line", () => {
    const changes = resolvePoCostChanges(
      [{ id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 1450 }],
      new Map([["vbl_1", 1200]])
    );
    expect(changes).toEqual([
      { purchase_order_line_id: "pol_1", unit_cost_cents: 1450 },
    ]);
  });

  it("stays silent when the save re-sends the same cost", () => {
    const changes = resolvePoCostChanges(
      [{ id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 1200 }],
      new Map([["vbl_1", 1200]])
    );
    expect(changes).toEqual([]);
  });

  it("never reprices from a line being inserted by this same save", () => {
    // A new line has no "before" — adding it is not a price correction, and
    // treating it as one would push a cost nobody edited.
    const changes = resolvePoCostChanges(
      [{ purchase_order_line_id: "pol_1", unit_cost_cents: 9999 }],
      new Map()
    );
    expect(changes).toEqual([]);
  });

  it("skips a PO line two bill lines disagree about", () => {
    // Split shipment priced apart: there is no single number to push, so the
    // PO keeps its own rather than silently taking whichever came last.
    const changes = resolvePoCostChanges(
      [
        { id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 1450 },
        { id: "vbl_2", purchase_order_line_id: "pol_1", unit_cost_cents: 1500 },
      ],
      new Map([
        ["vbl_1", 1200],
        ["vbl_2", 1200],
      ])
    );
    expect(changes).toEqual([]);
  });

  it("reprices once when two bill lines agree on the new cost", () => {
    const changes = resolvePoCostChanges(
      [
        { id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 1450 },
        { id: "vbl_2", purchase_order_line_id: "pol_1", unit_cost_cents: 1450 },
      ],
      new Map([
        ["vbl_1", 1200],
        ["vbl_2", 1200],
      ])
    );
    expect(changes).toEqual([
      { purchase_order_line_id: "pol_1", unit_cost_cents: 1450 },
    ]);
  });

  it("carries only the changed line when others held still", () => {
    const changes = resolvePoCostChanges(
      [
        { id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 1200 },
        { id: "vbl_2", purchase_order_line_id: "pol_2", unit_cost_cents: 3300 },
      ],
      new Map([
        ["vbl_1", 1200],
        ["vbl_2", 3000],
      ])
    );
    expect(changes).toEqual([
      { purchase_order_line_id: "pol_2", unit_cost_cents: 3300 },
    ]);
  });

  it("propagates a cost corrected DOWN, not just up", () => {
    const changes = resolvePoCostChanges(
      [{ id: "vbl_1", purchase_order_line_id: "pol_1", unit_cost_cents: 900 }],
      new Map([["vbl_1", 1200]])
    );
    expect(changes).toEqual([
      { purchase_order_line_id: "pol_1", unit_cost_cents: 900 },
    ]);
  });
});
