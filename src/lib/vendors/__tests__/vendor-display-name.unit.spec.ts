import { resolveVendorDisplayName } from "../vendor-display-name";

describe("resolveVendorDisplayName", () => {
  it("prefers CompanyName consistently when QuickBooks names differ", () => {
    expect(
      resolveVendorDisplayName({
        id: "veetech",
        company_name: "Shenzhen Veetech Co., Ltd",
        full_name: "VEETECH Co., Ltd",
        name: "VEETECH Co., Ltd",
      })
    ).toBe("Shenzhen Veetech Co., Ltd");
  });

  it("falls back through FullName, Name, id, and explicit fallback", () => {
    expect(resolveVendorDisplayName({ full_name: "Full" })).toBe("Full");
    expect(resolveVendorDisplayName({ name: "Name" })).toBe("Name");
    expect(resolveVendorDisplayName({ id: "vendor-id" })).toBe("vendor-id");
    expect(resolveVendorDisplayName({}, "fallback")).toBe("fallback");
  });

  it("ignores blank values", () => {
    expect(
      resolveVendorDisplayName({
        company_name: " ",
        full_name: "",
        name: "Canonical",
      })
    ).toBe("Canonical");
  });
});
