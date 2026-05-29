import { computeFullyInvoiced } from "../../lib/invoices/compute-fully-invoiced";

describe("computeFullyInvoiced", () => {
  it("returns false when the order has no lines", () => {
    expect(computeFullyInvoiced([], [{ sku: "A", quantity: 1 }])).toBe(false);
  });

  it("returns false when nothing has been invoiced", () => {
    const order = [{ quantity: 2, variant_sku: "A" }];
    expect(computeFullyInvoiced(order, [])).toBe(false);
  });

  it("returns false when only partially invoiced", () => {
    const order = [{ quantity: 3, variant_id: "v1", variant_sku: "A" }];
    const invoices = [{ variant_id: "v1", sku: "A", quantity: 1 }];
    expect(computeFullyInvoiced(order, invoices)).toBe(false);
  });

  it("returns true when every line is fully covered", () => {
    const order = [
      { quantity: 2, variant_id: "v1", variant_sku: "A" },
      { quantity: 1, variant_id: "v2", variant_sku: "B" },
    ];
    const invoices = [
      { variant_id: "v1", sku: "A", quantity: 2 },
      { variant_id: "v2", sku: "B", quantity: 1 },
    ];
    expect(computeFullyInvoiced(order, invoices)).toBe(true);
  });

  it("matches duplicate-SKU order lines to distinct invoice lines (FIFO, no double-count)", () => {
    // Two separate order lines of the same SKU, each qty 1. A single invoice
    // line of qty 1 must NOT satisfy both — only one line is covered.
    const order = [
      { quantity: 1, variant_id: "v1", variant_sku: "A" },
      { quantity: 1, variant_id: "v1", variant_sku: "A" },
    ];
    const onePartial = [{ variant_id: "v1", sku: "A", quantity: 1 }];
    expect(computeFullyInvoiced(order, onePartial)).toBe(false);

    const both = [
      { variant_id: "v1", sku: "A", quantity: 1 },
      { variant_id: "v1", sku: "A", quantity: 1 },
    ];
    expect(computeFullyInvoiced(order, both)).toBe(true);
  });

  it("matches by SKU when variant_id is absent (custom lines)", () => {
    const order = [{ quantity: 1, variant_sku: "A" }];
    const invoices = [{ sku: "A", quantity: 1 }];
    expect(computeFullyInvoiced(order, invoices)).toBe(true);
  });

  it("covers an order edited down to a quantity prior partial invoices satisfy", () => {
    // Ordered 5, invoiced 2 (partial). Order later edited down to qty 2 →
    // the existing 2 invoiced units now fully cover it → no longer separated.
    const editedDown = [{ quantity: 2, variant_id: "v1", variant_sku: "A" }];
    const partial = [{ variant_id: "v1", sku: "A", quantity: 2 }];
    expect(computeFullyInvoiced(editedDown, partial)).toBe(true);
  });

  it("does not let a non-matching invoice line satisfy a line", () => {
    const order = [{ quantity: 1, variant_id: "v1", variant_sku: "A" }];
    const wrong = [{ variant_id: "v2", sku: "B", quantity: 5 }];
    expect(computeFullyInvoiced(order, wrong)).toBe(false);
  });
});
