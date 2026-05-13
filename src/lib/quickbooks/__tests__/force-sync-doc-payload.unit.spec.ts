import {
  buildInvoiceForceSyncActiveItems,
  invoiceLineDiscountCents,
} from "../force-sync-doc-payload";

describe("force sync document payload helpers", () => {
  it("bakes invoice item discounts into line subtotal and reports only the item discount", () => {
    const { activeItems, invoiceLineDiscountCents } =
      buildInvoiceForceSyncActiveItems(
        [
          {
            id: "pii_1",
            variant_id: "variant_strip",
            sku: "ESPDO1R4N75W1040",
            description: "LED Strip",
            quantity: 5,
            unit_price: 6625,
            total: 33125,
            discount_type: "percent",
            discount_value: 50,
          },
        ],
        [
          {
            id: "orditem_1",
            variant_id: "variant_strip",
            variant: {
              metadata: { quickbooks_id: "80001B94-1750352564" },
            },
            quantity: 5,
            unit_price: 33.13,
            metadata: {
              line_discount: { type: "percent", value: 50 },
              original_unit_price: 66.25,
            },
          },
        ]
      );

    expect(invoiceLineDiscountCents).toBe(16563);
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].unit_price).toBe(66.25);
    expect(activeItems[0].subtotal).toBe(165.62);
  });

  it("matches duplicate SKUs by quantity and gross amount before consuming parent discounts", () => {
    const { activeItems, invoiceLineDiscountCents } =
      buildInvoiceForceSyncActiveItems(
        [
          {
            id: "pii_discounted",
            variant_id: "variant_strip",
            sku: "ESPDO1R4N75W1040",
            quantity: 5,
            unit_price: 6625,
            total: 33125,
          },
          {
            id: "pii_regular",
            variant_id: "variant_strip",
            sku: "ESPDO1R4N75W1040",
            quantity: 6,
            unit_price: 6075,
            total: 36450,
          },
        ],
        [
          {
            id: "orditem_discounted",
            variant_id: "variant_strip",
            quantity: 5,
            unit_price: 33.13,
            metadata: {
              line_discount: { type: "percent", value: 50 },
              original_unit_price: 66.25,
            },
          },
          {
            id: "orditem_regular",
            variant_id: "variant_strip",
            quantity: 6,
            unit_price: 60.75,
            metadata: {},
          },
        ]
      );

    expect(invoiceLineDiscountCents).toBe(16563);
    expect(activeItems.map((item) => item.id)).toEqual([
      "orditem_discounted",
      "orditem_regular",
    ]);
    expect(activeItems.map((item) => item.subtotal)).toEqual([165.62, 364.5]);
  });

  it("caps fixed line discounts to the gross line total", () => {
    expect(
      invoiceLineDiscountCents(
        { quantity: 2, discount_type: "fixed", discount_value: 100 },
        null,
        5000
      )
    ).toBe(5000);
  });
});
