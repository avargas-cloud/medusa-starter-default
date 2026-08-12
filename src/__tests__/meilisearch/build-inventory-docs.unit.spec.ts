import { buildInventoryDocsForVariants } from "../../lib/meilisearch/build-inventory-docs";

const baseVariant = {
  id: "variant_1",
  sku: "EAS1-D6024",
  metadata: {
    purchase_cost: 9.46,
    average_cost: 12.68,
    qb_purchase_desc: "Canonical QB purchase description",
    purchase_description: "Legacy purchase description",
  },
  product: {
    id: "product_1",
    title: "LED Driver",
    status: "published",
    metadata: {},
    categories: [],
  },
  prices: [],
  options: [],
  inventory_items: [],
  created_at: "2026-07-27T00:00:00.000Z",
  updated_at: "2026-07-27T00:00:00.000Z",
};

describe("buildInventoryDocsForVariants", () => {
  it("indexes purchase cost separately and prefers canonical QB purchase description", () => {
    const [doc] = buildInventoryDocsForVariants([baseVariant]);

    expect(doc.purchaseCost).toBe(9.46);
    expect(doc.cost).toBe(12.68);
    expect(doc.purchaseDescription).toBe(
      "Canonical QB purchase description"
    );
  });

  it("keeps the legacy purchase description readable", () => {
    const [doc] = buildInventoryDocsForVariants([
      {
        ...baseVariant,
        metadata: {
          ...baseVariant.metadata,
          qb_purchase_desc: undefined,
        },
      },
    ]);

    expect(doc.purchaseDescription).toBe("Legacy purchase description");
  });
});

/**
 * vendorName resolution. The product-level metadata is the authoritative
 * "Preferred Vendor"; the variant↔qb_vendor link table is an older association
 * that diverges from it on 105 production variants and must never win.
 *
 * Regression guarded: SUP-AP-IP-SM1-8S indexed as "HK HELIAN OPTOELECTRONICS
 * CO., LIMITED" (the link) while its product said "Luxury LED LLC", which made
 * the PO's Linked Orders picker attribute customer orders to the wrong vendor.
 */
describe("buildInventoryDocsForVariants — vendorName", () => {
  const LINK = new Map([["variant_1", "HK HELIAN OPTOELECTRONICS CO., LIMITED"]]);

  const withProductMeta = (metadata: Record<string, unknown>) => ({
    ...baseVariant,
    product: { ...baseVariant.product, metadata },
  });

  it("prefers the renamed product-level key over everything else", () => {
    const [doc] = buildInventoryDocsForVariants(
      [
        withProductMeta({
          vendor_full_name: "Luxury LED LLC",
          qb_vendor_full_name: "Stale Legacy Vendor",
        }),
      ],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      LINK
    );

    expect(doc.vendorName).toBe("Luxury LED LLC");
  });

  it("falls back to the legacy product-level key before the link table", () => {
    const [doc] = buildInventoryDocsForVariants(
      [withProductMeta({ qb_vendor_full_name: "Luxury LED LLC" })],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      LINK
    );

    expect(doc.vendorName).toBe("Luxury LED LLC");
  });

  it("uses the link table only when the product carries no vendor metadata", () => {
    const [doc] = buildInventoryDocsForVariants(
      [withProductMeta({})],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      LINK
    );

    expect(doc.vendorName).toBe("HK HELIAN OPTOELECTRONICS CO., LIMITED");
  });

  it("is null when neither the product nor the link names a vendor", () => {
    const [doc] = buildInventoryDocsForVariants([withProductMeta({})]);

    expect(doc.vendorName).toBeNull();
  });
});
