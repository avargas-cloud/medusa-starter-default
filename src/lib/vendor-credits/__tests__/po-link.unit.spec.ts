import {
  assertNoProductLinesWithoutPo,
  computeReturnable,
  validateProductLinesAgainstPo,
  type PoForCredit,
} from "../po-link";
import type { VendorCreditLineInput } from "../types";

function po(lines: Array<Partial<PoForCredit["lines"] extends Map<string, infer V> ? V : never> & { id: string }>): PoForCredit {
  return {
    id: "po_1",
    number: "PO-1001",
    status: "received",
    vendor_id: "qbv_1",
    stock_location_id: "sloc_usa",
    lines: new Map(
      lines.map((l) => [
        l.id,
        {
          id: l.id,
          product_variant_id: l.product_variant_id ?? `variant_${l.id}`,
          inventory_item_id: l.inventory_item_id ?? `iitem_${l.id}`,
          sku_snapshot: l.sku_snapshot ?? `SKU-${l.id}`,
          description_snapshot: l.description_snapshot ?? `Desc ${l.id}`,
          qty_received: l.qty_received ?? 0,
          unit_cost_cents: l.unit_cost_cents ?? 1000,
        },
      ])
    ),
  };
}

const product = (over: Partial<VendorCreditLineInput>): VendorCreditLineInput => ({
  line_type: "product",
  qty: 1,
  unit_cost_cents: 1000,
  amount_cents: 1000,
  ...over,
});

describe("computeReturnable", () => {
  it("received − credited, floored at zero", () => {
    expect(computeReturnable(10, 3)).toBe(7);
    expect(computeReturnable(10, 10)).toBe(0);
    expect(computeReturnable(2, 5)).toBe(0);
    expect(computeReturnable(0, 0)).toBe(0);
  });
});

describe("assertNoProductLinesWithoutPo", () => {
  it("lets account-only credits through", () => {
    expect(() =>
      assertNoProductLinesWithoutPo([{ line_type: "qb_account", qb_account_list_id: "8", amount_cents: 5 }])
    ).not.toThrow();
  });
  it("refuses a product line on a credit with no PO", () => {
    expect(() => assertNoProductLinesWithoutPo([product({})])).toThrow(
      expect.objectContaining({ code: "product_line_requires_po" })
    );
  });
});

describe("validateProductLinesAgainstPo", () => {
  const PO = po([
    { id: "pol_a", qty_received: 10 },
    { id: "pol_b", qty_received: 0 },
  ]);

  it("requires every product line to name a PO line", () => {
    expect(() => validateProductLinesAgainstPo([product({})], PO, new Map())).toThrow(
      expect.objectContaining({ code: "po_line_required" })
    );
  });

  it("refuses a PO line that is not on this PO", () => {
    expect(() =>
      validateProductLinesAgainstPo([product({ purchase_order_line_id: "pol_zzz" })], PO, new Map())
    ).toThrow(expect.objectContaining({ code: "po_line_not_in_po" }));
  });

  it("refuses a PO line with nothing received", () => {
    expect(() =>
      validateProductLinesAgainstPo([product({ purchase_order_line_id: "pol_b" })], PO, new Map())
    ).toThrow(expect.objectContaining({ code: "po_line_not_received" }));
  });

  it("refuses qty that is not a whole number ≥ 1", () => {
    for (const qty of [0, -1, 1.5, undefined, null]) {
      expect(() =>
        validateProductLinesAgainstPo([product({ purchase_order_line_id: "pol_a", qty })], PO, new Map())
      ).toThrow(expect.objectContaining({ code: "invalid_qty" }));
    }
  });

  it("caps at received minus what OTHER active credits already claim", () => {
    const credited = new Map([["pol_a", 7]]);
    expect(() =>
      validateProductLinesAgainstPo([product({ purchase_order_line_id: "pol_a", qty: 3 })], PO, credited)
    ).not.toThrow();
    expect(() =>
      validateProductLinesAgainstPo([product({ purchase_order_line_id: "pol_a", qty: 4 })], PO, credited)
    ).toThrow(expect.objectContaining({ code: "exceeds_returnable" }));
  });

  it("sums repeated lines for the same PO line within ONE request", () => {
    expect(() =>
      validateProductLinesAgainstPo(
        [
          product({ purchase_order_line_id: "pol_a", qty: 6 }),
          product({ purchase_order_line_id: "pol_a", qty: 5 }),
        ],
        PO,
        new Map()
      )
    ).toThrow(expect.objectContaining({ code: "exceeds_returnable" }));
  });

  it("refuses a variant that contradicts the PO line", () => {
    expect(() =>
      validateProductLinesAgainstPo(
        [product({ purchase_order_line_id: "pol_a", variant_id: "variant_other" })],
        PO,
        new Map()
      )
    ).toThrow(expect.objectContaining({ code: "variant_mismatch" }));
  });

  it("defaults variant/sku/description from the PO line and keeps explicit sku/description", () => {
    const out = validateProductLinesAgainstPo(
      [
        product({ purchase_order_line_id: "pol_a" }),
        product({ purchase_order_line_id: "pol_a", sku: "MINE", description: "mine" }),
        { line_type: "qb_account", qb_account_list_id: "8", amount_cents: 5 },
      ],
      PO,
      new Map()
    );
    expect(out[0]).toMatchObject({ variant_id: "variant_pol_a", sku: "SKU-pol_a", description: "Desc pol_a" });
    expect(out[1]).toMatchObject({ variant_id: "variant_pol_a", sku: "MINE", description: "mine" });
    expect(out[2]).toEqual({ line_type: "qb_account", qb_account_list_id: "8", amount_cents: 5 });
  });
});
