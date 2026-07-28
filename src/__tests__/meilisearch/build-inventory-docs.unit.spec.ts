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
