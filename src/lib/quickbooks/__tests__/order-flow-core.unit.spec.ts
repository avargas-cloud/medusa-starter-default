import {
  getEffectiveOrderDiscount,
  buildQbItems,
  buildQbOrderDiscountLines,
  buildShippingQbItem,
} from "../order-flow-core";

describe("getEffectiveOrderDiscount", () => {
  it("returns discount_total when populated and > 0", () => {
    expect(
      getEffectiveOrderDiscount({ discount_total: 875.33, items: [] })
    ).toBe(875.33);
  });

  it("returns 0 when no source has data", () => {
    expect(getEffectiveOrderDiscount({})).toBe(0);
    expect(
      getEffectiveOrderDiscount({ discount_total: 0, items: [], metadata: {} })
    ).toBe(0);
  });

  it("falls back to summing item adjustments when discount_total is 0", () => {
    const order = {
      discount_total: 0,
      items: [
        { adjustments: [{ amount: 65.09 }, { amount: 91.39 }] },
        { adjustments: [{ amount: 220.61 }] },
      ],
    };
    expect(getEffectiveOrderDiscount(order)).toBeCloseTo(377.09, 2);
  });

  it("ignores soft-deleted adjustments in the fallback", () => {
    const order = {
      discount_total: 0,
      items: [
        {
          adjustments: [
            { amount: 100, deleted_at: null },
            { amount: 50, deleted_at: "2026-04-30T00:00:00Z" },
          ],
        },
      ],
    };
    expect(getEffectiveOrderDiscount(order)).toBe(100);
  });

  it("falls back to metadata.computed_discount when discount_total and adjustments are 0", () => {
    const order = {
      discount_total: 0,
      items: [{ adjustments: [] }],
      metadata: { computed_discount: 875.33 },
    };
    expect(getEffectiveOrderDiscount(order)).toBe(875.33);
  });

  it("prefers discount_total over fallbacks when present", () => {
    const order = {
      discount_total: 100,
      items: [{ adjustments: [{ amount: 50 }] }],
      metadata: { computed_discount: 200 },
    };
    expect(getEffectiveOrderDiscount(order)).toBe(100);
  });

  it("prefers adjustments over metadata when discount_total is 0", () => {
    const order = {
      discount_total: 0,
      items: [{ adjustments: [{ amount: 50 }] }],
      metadata: { computed_discount: 200 },
    };
    expect(getEffectiveOrderDiscount(order)).toBe(50);
  });

  it("is robust to missing items array", () => {
    expect(getEffectiveOrderDiscount({ discount_total: 0 })).toBe(0);
    expect(
      getEffectiveOrderDiscount({
        discount_total: 0,
        metadata: { computed_discount: 12 },
      })
    ).toBe(12);
  });

  it("is robust to items without adjustments arrays", () => {
    const order = {
      discount_total: 0,
      items: [{}, { adjustments: null }, { adjustments: undefined }],
      metadata: { computed_discount: 7 },
    };
    expect(getEffectiveOrderDiscount(order)).toBe(7);
  });

  it("handles string-typed amounts (Medusa raw precision)", () => {
    const order = {
      discount_total: "875.33",
      items: [],
    };
    expect(getEffectiveOrderDiscount(order)).toBeCloseTo(875.33, 2);
  });

  it("treats negative discount_total as not present (defensive)", () => {
    const order = {
      discount_total: -10,
      items: [{ adjustments: [{ amount: 50 }] }],
    };
    expect(getEffectiveOrderDiscount(order)).toBe(50);
  });

  it("real-world: order 1350 (12% promotion as per-item adjustments)", () => {
    const order = {
      discount_total: 0,
      items: [
        { adjustments: [{ amount: 65.09 }] },
        { adjustments: [{ amount: 220.61 }] },
        { adjustments: [{ amount: 134.78 }] },
        { adjustments: [{ amount: 91.39 }] },
        { adjustments: [{ amount: 91.58 }] },
        { adjustments: [{ amount: 122.5 }] },
        { adjustments: [{ amount: 149.38 }] },
      ],
      metadata: { computed_discount: 875.33 },
    };
    expect(getEffectiveOrderDiscount(order)).toBeCloseTo(875.33, 2);
  });
});

describe("buildQbItems", () => {
  it("marks QB service items as noSite from product qb_item_type metadata", () => {
    const [item] = buildQbItems([
      {
        title: "Assembly Panels",
        quantity: 1,
        unit_price: 2100,
        product_id: "prod_service",
        variant: {
          sku: "Services:Assembly-Panels",
          product_id: "prod_service",
          metadata: {
            quickbooks_id: "80000001-TEST",
          },
        },
      },
    ] as any, undefined, {
      prod_service: {
        taxable: true,
        metadata: {
          qb_item_type: "Service",
        },
      },
    });

    expect(item.productId).toBe("80000001-TEST");
    expect(item.qbItemType).toBe("Service");
    expect(item.noSite).toBe(true);
    expect(item.taxable).toBe(false);
  });

  it("does not mark inventory items as noSite from qb_item_type metadata", () => {
    const [item] = buildQbItems([
      {
        title: "Tape Light",
        quantity: 2,
        unit_price: 10,
        variant: {
          sku: "TL-1",
          metadata: {
            quickbooks_id: "80000002-TEST",
            qb_item_type: "Inventory",
          },
        },
      },
    ]);

    expect(item.qbItemType).toBe("Inventory");
    expect(item.noSite).toBeUndefined();
    expect(item.taxable).toBeUndefined();
  });
});

describe("buildQbOrderDiscountLines", () => {
  it("returns empty array when discount is 0 or negative", () => {
    expect(buildQbOrderDiscountLines(0)).toEqual([]);
    expect(buildQbOrderDiscountLines(-5)).toEqual([]);
  });

  it("returns Subtotal + Discount lines for a positive discount", () => {
    const lines = buildQbOrderDiscountLines(875.33, 12);
    expect(lines).toHaveLength(2);

    const [subtotal, discount] = lines;
    expect(subtotal.productName).toBe("Subtotal");
    expect(subtotal.noSite).toBe(true);
    // QB Subtotal item type does NOT accept Quantity
    expect(subtotal).not.toHaveProperty("quantity");

    expect(discount.productName).toBe("Discount");
    expect(discount.price).toBe(875.33);
    expect(discount.amount).toBe(875.33);
    expect(discount.desc).toContain("12%");
    expect(discount.noSite).toBe(true);
    // QB Discount item type does NOT accept Quantity
    expect(discount).not.toHaveProperty("quantity");
  });

  it("omits the percent suffix when discountPercent is null/undefined", () => {
    const lines = buildQbOrderDiscountLines(50);
    expect(lines[1].desc).toBe("Order Discount");
  });

  it("rounds the percent display to whole numbers", () => {
    const lines = buildQbOrderDiscountLines(875.33, 11.999);
    expect(lines[1].desc).toContain("(12%)");
  });
});

describe("buildShippingQbItem", () => {
  it("returns null when shipping methods array is empty/missing", () => {
    expect(buildShippingQbItem([])).toBeNull();
    expect(buildShippingQbItem(undefined as any)).toBeNull();
    expect(buildShippingQbItem(null as any)).toBeNull();
  });

  it("returns null when only pickup methods are present", () => {
    expect(
      buildShippingQbItem([{ name: "Store Pickup", amount: 0 }])
    ).toBeNull();
    expect(buildShippingQbItem([{ name: "Local pick-up", amount: 50 }])).toBeNull();
  });

  it("returns null when shipping amount is 0 (free shipping)", () => {
    expect(buildShippingQbItem([{ name: "FedEx", amount: 0 }])).toBeNull();
  });

  it("returns a shipping line for a non-pickup method with amount > 0", () => {
    const item = buildShippingQbItem([{ name: "FedEx Ground", amount: 25.5 }]);
    expect(item).not.toBeNull();
    expect(item!.quantity).toBe(1);
    expect(item!.price).toBe(25.5);
    expect(item!.amount).toBe(25.5);
    expect(item!.desc).toBe("FedEx Ground");
    expect(item!.noSite).toBe(true);
    // Must use ListID (productId), not productName — QB rejects "&" in product names
    expect(item!.productId).toBeTruthy();
    expect(item!.productName).toBeUndefined();
  });

  it("uses provided ListID override when given", () => {
    const override = "80000999-1234567890";
    const item = buildShippingQbItem(
      [{ name: "UPS", amount: 10 }],
      override
    );
    expect(item!.productId).toBe(override);
  });

  it("picks the first non-pickup method when both pickup and shipping coexist", () => {
    const item = buildShippingQbItem([
      { name: "Store Pickup", amount: 0 },
      { name: "FedEx Ground", amount: 25 },
    ]);
    expect(item!.desc).toBe("FedEx Ground");
    expect(item!.amount).toBe(25);
  });

  it("falls back to shipping_option.name when method.name is missing", () => {
    const item = buildShippingQbItem([
      { shipping_option: { name: "Express" }, amount: 30 },
    ]);
    expect(item!.desc).toBe("Express");
  });
});
