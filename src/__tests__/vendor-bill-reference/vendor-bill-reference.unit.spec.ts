import { normalizeRequiredVendorBillReference } from "../../lib/purchase-orders/vendor-bill-reference-uniqueness";

describe("normalizeRequiredVendorBillReference", () => {
  it.each([undefined, null, "", "   ", "\t\n"])(
    "rejects a missing or blank reference (%p)",
    (reference) => {
      expect(normalizeRequiredVendorBillReference(reference)).toBeNull();
    }
  );

  it("trims the Vendor PI before persistence", () => {
    expect(normalizeRequiredVendorBillReference("  PI-1042 / A  ")).toBe(
      "PI-1042 / A"
    );
  });
});
