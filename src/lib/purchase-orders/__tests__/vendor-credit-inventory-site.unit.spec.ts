import {
  DEFAULT_QB_INVENTORY_SITE_LIST_ID,
  resolveVendorCreditLineSite,
} from "../vendor-credit-inventory-site";

describe("resolveVendorCreditLineSite", () => {
  it("falls back to Principal Warehouse when the location has no override", () => {
    expect(resolveVendorCreditLineSite({ locationSiteListId: null })).toBe(DEFAULT_QB_INVENTORY_SITE_LIST_ID);
    expect(DEFAULT_QB_INVENTORY_SITE_LIST_ID).toBe("80000001-1331053531");
  });

  it("uses the stock_location override when present", () => {
    expect(resolveVendorCreditLineSite({ locationSiteListId: "8000000C-1381786310" })).toBe("8000000C-1381786310");
  });

  it("returns null (no tag) for service / non-inventory items — QB rejects InventorySiteRef there (3140)", () => {
    for (const qbItemType of ["Service", "NonInventory", "NonInventoryPart", "OtherCharge"]) {
      expect(resolveVendorCreditLineSite({ locationSiteListId: null, qbItemType })).toBeNull();
    }
    expect(resolveVendorCreditLineSite({ locationSiteListId: null, quickbooksIsService: "true" })).toBeNull();
    expect(resolveVendorCreditLineSite({ locationSiteListId: null, quickbooksNoSite: true })).toBeNull();
    expect(resolveVendorCreditLineSite({ locationSiteListId: null, qbItemType: "Inventory" })).toBe(
      DEFAULT_QB_INVENTORY_SITE_LIST_ID
    );
  });
});
