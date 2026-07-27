import { receiptQuantitiesMatchBill } from "../../lib/purchase-orders/vendor-bill-receipts";

describe("receiptQuantitiesMatchBill", () => {
  it("matches an exact multi-receipt union by purchase order line", () => {
    expect(
      receiptQuantitiesMatchBill(
        [
          { purchase_order_line_id: "pol_1", qty: 10 },
          { purchase_order_line_id: "pol_2", qty: 5 },
        ],
        [
          { purchase_order_line_id: "pol_1", qty: 4 },
          { purchase_order_line_id: "pol_1", qty: 6 },
          { purchase_order_line_id: "pol_2", qty: 5 },
        ]
      )
    ).toBe(true);
  });

  it("rejects partial receipt coverage", () => {
    expect(
      receiptQuantitiesMatchBill(
        [{ purchase_order_line_id: "pol_1", qty: 10 }],
        [{ purchase_order_line_id: "pol_1", qty: 9 }]
      )
    ).toBe(false);
  });

  it("rejects extra receipt lines", () => {
    expect(
      receiptQuantitiesMatchBill(
        [{ purchase_order_line_id: "pol_1", qty: 10 }],
        [
          { purchase_order_line_id: "pol_1", qty: 10 },
          { purchase_order_line_id: "pol_2", qty: 1 },
        ]
      )
    ).toBe(false);
  });

  it("rejects unlinked or empty bill lines", () => {
    expect(
      receiptQuantitiesMatchBill(
        [{ purchase_order_line_id: null, qty: 10 }],
        [{ purchase_order_line_id: "pol_1", qty: 10 }]
      )
    ).toBe(false);
    expect(receiptQuantitiesMatchBill([], [])).toBe(false);
  });
});
