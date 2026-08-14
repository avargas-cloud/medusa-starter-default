import { allocateInvoicedToLines } from "../../lib/invoices/per-line-invoiced";

describe("allocateInvoicedToLines", () => {
  it("keeps direct attribution and adds nothing from an empty pool", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 5, directInvoiced: 2 }],
      []
    );
    expect(out.get("l1")).toBe(2);
  });

  it("allocates pool items to the line by variant_id", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 5, directInvoiced: 0 }],
      [{ variantId: "v1", sku: null, quantity: 3 }]
    );
    expect(out.get("l1")).toBe(3);
  });

  it("falls back to SKU when the pool entry has no matching variant", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 5, directInvoiced: 0 }],
      [{ variantId: null, sku: "A", quantity: 4 }]
    );
    expect(out.get("l1")).toBe(4);
  });

  it("never allocates beyond the line quantity", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 3, directInvoiced: 1 }],
      [{ variantId: "v1", sku: "A", quantity: 10 }]
    );
    expect(out.get("l1")).toBe(3);
  });

  it("does not give an unrelated line someone else's units", () => {
    const out = allocateInvoicedToLines(
      [
        { lineId: "l1", variantId: "v1", sku: "A", quantity: 5, directInvoiced: 0 },
        { lineId: "l2", variantId: "v2", sku: "B", quantity: 5, directInvoiced: 0 },
      ],
      [{ variantId: "v1", sku: "A", quantity: 2 }]
    );
    expect(out.get("l1")).toBe(2);
    expect(out.get("l2")).toBe(0);
  });

  it("splits a shared-variant pool across duplicate lines without changing the order total", () => {
    const out = allocateInvoicedToLines(
      [
        { lineId: "l1", variantId: "v1", sku: "A", quantity: 3, directInvoiced: 0 },
        { lineId: "l2", variantId: "v1", sku: "A", quantity: 3, directInvoiced: 0 },
      ],
      [{ variantId: "v1", sku: "A", quantity: 4 }]
    );
    // FIFO fills the first twin, remainder spills to the second — which twin
    // holds which share is convention, but the sum is not.
    expect(out.get("l1")).toBe(3);
    expect(out.get("l2")).toBe(1);
    expect((out.get("l1") ?? 0) + (out.get("l2") ?? 0)).toBe(4);
  });

  it("consumes multiple pool entries for one line", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 6, directInvoiced: 0 }],
      [
        { variantId: "v1", sku: "A", quantity: 2 },
        { variantId: null, sku: "A", quantity: 3 },
      ]
    );
    expect(out.get("l1")).toBe(5);
  });

  it("treats negative and non-finite quantities as zero", () => {
    const out = allocateInvoicedToLines(
      [{ lineId: "l1", variantId: "v1", sku: "A", quantity: 5, directInvoiced: -2 }],
      [{ variantId: "v1", sku: "A", quantity: Number.NaN }]
    );
    expect(out.get("l1")).toBe(0);
  });
});
