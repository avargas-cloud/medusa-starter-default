import { decideStockMovement, type VendorCreditStockState } from "../stock-lines";

const line = { credit_line_id: "vcrl_1", purchase_order_line_id: "pol_1", inventory_item_id: "iitem_1", sku: "SKU-1", qty: 3 };

function state(over: Partial<VendorCreditStockState> = {}): VendorCreditStockState {
  return {
    id: "vcr_1",
    status: "posted",
    purchase_order_id: "po_1",
    stock_location_id: "sloc_usa",
    stock_applied_at: null,
    stock_reversed_at: null,
    lines: [line],
    ...over,
  };
}

describe("decideStockMovement", () => {
  it("apply: runs once for a posted PO-linked credit with product lines, at the PO's location", () => {
    expect(decideStockMovement(state(), "apply")).toEqual({
      run: true,
      direction: "apply",
      location_id: "sloc_usa",
      lines: [line],
    });
  });

  it("apply: no-op (never an error) without PO / location / product lines / posted status / when already applied", () => {
    expect(decideStockMovement(state({ purchase_order_id: null }), "apply")).toMatchObject({ run: false });
    expect(decideStockMovement(state({ stock_location_id: null }), "apply")).toMatchObject({ run: false });
    expect(decideStockMovement(state({ lines: [] }), "apply")).toMatchObject({ run: false });
    expect(decideStockMovement(state({ status: "draft" }), "apply")).toMatchObject({ run: false });
    expect(decideStockMovement(state({ stock_applied_at: "2026-09-11T12:00:00Z" }), "apply")).toMatchObject({
      run: false,
      reason: expect.stringContaining("already applied"),
    });
  });

  it("reverse: runs only after an apply and only once", () => {
    expect(decideStockMovement(state(), "reverse")).toMatchObject({ run: false, reason: "stock was never applied" });
    expect(
      decideStockMovement(state({ status: "voided", stock_applied_at: "2026-09-11T12:00:00Z" }), "reverse")
    ).toEqual({ run: true, direction: "reverse", location_id: "sloc_usa", lines: [line] });
    expect(
      decideStockMovement(
        state({ status: "voided", stock_applied_at: "2026-09-11T12:00:00Z", stock_reversed_at: "2026-09-11T13:00:00Z" }),
        "reverse"
      )
    ).toMatchObject({ run: false, reason: expect.stringContaining("already reversed") });
  });
});
