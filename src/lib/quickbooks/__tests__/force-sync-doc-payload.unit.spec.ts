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

    // Round-then-multiply: unit 66.25, 50% → discountedUnit round(6625*0.5)=3313
    // → net 3313*5=16565 → discount 33125-16565=16560.
    expect(invoiceLineDiscountCents).toBe(16560);
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].unit_price).toBe(66.25);
    expect(activeItems[0].subtotal).toBe(165.65);
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

    expect(invoiceLineDiscountCents).toBe(16560);
    expect(activeItems.map((item) => item.id)).toEqual([
      "orditem_discounted",
      "orditem_regular",
    ]);
    expect(activeItems.map((item) => item.subtotal)).toEqual([165.65, 364.5]);
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

  it("uses the frozen net_total_cents verbatim when present (round-then-multiply)", () => {
    // 65.99 x 20, 20% off. Round-then-multiply net = round(6599*0.8)=5279 -> 5279*20=105580.
    const { activeItems, invoiceLineDiscountCents } =
      buildInvoiceForceSyncActiveItems(
        [
          {
            id: "pii_new",
            variant_id: "variant_panel",
            sku: "LEDPANEL",
            quantity: 20,
            unit_price: 6599,
            total: 131980,
            net_total_cents: 105580, // frozen by the POS
            discount_type: "percent",
            discount_value: 20,
          },
        ],
        [
          {
            id: "orditem_new",
            variant_id: "variant_panel",
            variant: { metadata: { quickbooks_id: "QB-1" } },
            quantity: 20,
            unit_price: 52.79,
            metadata: {
              line_discount: { type: "percent", value: 20 },
              original_unit_price: 65.99,
            },
          },
        ]
      );

    expect(activeItems[0].subtotal).toBe(1055.8); // NOT 1055.84
    expect(invoiceLineDiscountCents).toBe(26400); // gross 131980 - net 105580
  });

  it("recomputes round-then-multiply when net_total_cents is absent (correct from root)", () => {
    // No frozen net → the recompute is now round-then-multiply too, so a NULL row
    // still yields the correct 1055.80 (NOT the old 1055.84). Existing documents are
    // protected by the net_total_cents backfill (column present → frozen value wins),
    // NOT by this fallback.
    const { activeItems, invoiceLineDiscountCents } =
      buildInvoiceForceSyncActiveItems(
        [
          {
            id: "pii_nofreeze",
            variant_id: "variant_panel",
            sku: "LEDPANEL",
            quantity: 20,
            unit_price: 6599,
            total: 131980,
            discount_type: "percent",
            discount_value: 20,
          },
        ],
        [
          {
            id: "orditem_nofreeze",
            variant_id: "variant_panel",
            variant: { metadata: { quickbooks_id: "QB-1" } },
            quantity: 20,
            unit_price: 52.79,
            metadata: {
              line_discount: { type: "percent", value: 20 },
              original_unit_price: 65.99,
            },
          },
        ]
      );

    expect(activeItems[0].subtotal).toBe(1055.8); // round-then-multiply, correct from root
    expect(invoiceLineDiscountCents).toBe(26400);
  });

  it("invoiceLineDiscountCents: percent is float-safe at the .5 boundary", () => {
    // unit 1.15, qty 1, 10% → discountedUnit round(115*90/100)=round(103.5)=104 → discount 11.
    // (1 - value/100) float math would give 103 → discount 12; this guards that.
    expect(
      invoiceLineDiscountCents(
        { quantity: 1, discount_type: "percent", discount_value: 10 },
        null,
        115
      )
    ).toBe(11);
  });

  it("invoiceLineDiscountCents: percent > 100% caps at the gross (no negative)", () => {
    expect(
      invoiceLineDiscountCents(
        { quantity: 2, discount_type: "percent", discount_value: 150 },
        null,
        2000
      )
    ).toBe(2000);
  });

  it("invoiceLineDiscountCents: fixed matches the backfill formula", () => {
    // Live fixed = min(gross, round(value*100)*qty); backfill subtracts the same → agree.
    expect(
      invoiceLineDiscountCents(
        { quantity: 3, discount_type: "fixed", discount_value: 1.23 },
        null,
        3000
      )
    ).toBe(369);
  });
});
