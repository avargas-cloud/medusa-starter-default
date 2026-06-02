/**
 * Unit tests for ensureMiamiLevelsStep (create-pos-product-v2).
 *
 * Key behaviors under test:
 *   • manage_inventory false → no-op (no query, no writes)
 *   • Inventory products require product_id + product graph result
 *   • missing variant inventory links are auto-created and linked
 *   • creates Miami level @0 only for items missing one (idempotent)
 *   • race-created Miami levels are accepted after retry check
 *   • unrecoverable Miami level failures still fail before QB/Meili sync
 */

jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createStep: (_name: string, fn: unknown) => fn,
  StepResponse: class StepResponse {
    data: unknown;
    compensation: unknown;
    constructor(data: unknown, compensation?: unknown) {
      this.data = data;
      this.compensation = compensation;
    }
  },
}));

jest.mock("@medusajs/utils", () => ({
  ContainerRegistrationKeys: { QUERY: "query" },
  Modules: { INVENTORY: "inventory", PRODUCT: "product" },
}));

import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { USA_LOC } from "../../../lib/locations";
import { ensureMiamiLevelsStep } from "../../../workflows/pos/steps/ensure-miami-levels-step";

interface InventoryMock {
  listInventoryLevels: jest.Mock;
  createInventoryItems: jest.Mock;
  createInventoryLevels: jest.Mock;
}

interface ProductMock {
  updateProductVariants: jest.Mock;
}

interface RemoteLinkMock {
  create: jest.Mock;
}

type StepFn = (
  input: { product_id: string; manage_inventory: boolean },
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{ data: { created_inventory_item_ids: string[]; already_present: number } }>;

const stepFn = ensureMiamiLevelsStep as unknown as StepFn;

function build(opts: {
  graph?: jest.Mock;
  inventory?: Partial<InventoryMock>;
  product?: ProductMock;
  remoteLink?: RemoteLinkMock;
}) {
  const query = { graph: opts.graph ?? jest.fn() };
  const inventory: InventoryMock = {
    listInventoryLevels: jest.fn().mockResolvedValue([]),
    createInventoryItems: jest.fn().mockResolvedValue({ id: "iitem_new" }),
    createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    ...opts.inventory,
  };
  const product =
    opts.product ?? { updateProductVariants: jest.fn().mockResolvedValue(undefined) };
  const remoteLink = opts.remoteLink ?? { create: jest.fn().mockResolvedValue(undefined) };
  const logger = { info: jest.fn(), warn: jest.fn() };
  return {
    resolve: jest.fn((key: string) => {
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === Modules.INVENTORY) return inventory;
      if (key === Modules.PRODUCT) return product;
      if (key === "remoteLink") return remoteLink;
      if (key === "logger") return logger;
      return null;
    }),
    query,
    inventory,
    product,
    remoteLink,
    logger,
  };
}

const productGraph = (variants: Array<{ inv: string[]; sku?: string; title?: string }>) => ({
  data: [
    {
      id: "prod_1",
      variants: variants.map((v, i) => ({
        id: `var_${i}`,
        sku: v.sku ?? `SKU-${i}`,
        title: v.title ?? `Variant ${i}`,
        inventory_items: v.inv.map((id) => ({ inventory_item_id: id })),
      })),
    },
  ],
});

describe("ensureMiamiLevelsStep", () => {
  it("is a no-op when manage_inventory is false", async () => {
    const c = build({});
    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: false },
      { container: c }
    );
    expect(c.query.graph).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryItems).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(result.data).toEqual({ created_inventory_item_ids: [], already_present: 0 });
  });

  it("throws when product_id is empty for an Inventory item", async () => {
    const c = build({});
    await expect(
      stepFn({ product_id: "", manage_inventory: true }, { container: c })
    ).rejects.toThrow("product_id is required");
    expect(c.query.graph).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
  });

  it("throws when an Inventory product is not found", async () => {
    const graph = jest.fn().mockResolvedValue({ data: [] });
    const c = build({ graph });
    await expect(
      stepFn({ product_id: "prod_x", manage_inventory: true }, { container: c })
    ).rejects.toThrow("product prod_x not found");
    expect(c.inventory.createInventoryItems).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
  });

  it("creates Miami levels @0 only for items missing one", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: ["iitem_1", "iitem_2"] }]));
    const inventory: Partial<InventoryMock> = {
      // iitem_2 already has a Miami level → only iitem_1 should be created
      listInventoryLevels: jest.fn().mockResolvedValue([{ inventory_item_id: "iitem_2" }]),
    };
    const c = build({ graph, inventory });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(c.inventory.createInventoryItems).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).toHaveBeenCalledTimes(1);
    expect(c.inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: USA_LOC, stocked_quantity: 0 },
    ]);
    expect(result.data).toEqual({
      created_inventory_item_ids: ["iitem_1"],
      already_present: 1,
    });
  });

  it("is idempotent when every linked inventory item already has a Miami level", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: ["iitem_1", "iitem_2"] }]));
    const inventory: Partial<InventoryMock> = {
      listInventoryLevels: jest
        .fn()
        .mockResolvedValue([{ inventory_item_id: "iitem_1" }, { inventory_item_id: "iitem_2" }]),
    };
    const c = build({ graph, inventory });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(c.inventory.createInventoryItems).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      created_inventory_item_ids: [],
      already_present: 2,
    });
  });

  it("auto-creates and links an inventory item when an Inventory variant has no link", async () => {
    const graph = jest
      .fn()
      .mockResolvedValue(productGraph([{ inv: [], sku: "NO-LINK", title: "Needs Link" }]));
    const c = build({ graph });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(c.inventory.createInventoryItems).toHaveBeenCalledWith({
      sku: "NO-LINK",
      title: "Needs Link",
      requires_shipping: true,
    });
    expect(c.remoteLink.create).toHaveBeenCalledWith({
      product: { variant_id: "var_0" },
      inventory: { inventory_item_id: "iitem_new" },
    });
    expect(c.product.updateProductVariants).toHaveBeenCalledWith("var_0", {
      manage_inventory: true,
    });
    expect(c.inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_new", location_id: USA_LOC, stocked_quantity: 0 },
    ]);
    expect(result.data).toEqual({
      created_inventory_item_ids: ["iitem_new"],
      already_present: 0,
    });
  });

  it("auto-repairs only the missing links when some variants are already linked", async () => {
    const graph = jest.fn().mockResolvedValue(
      productGraph([
        { inv: ["iitem_1"], sku: "HAS-LINK" },
        { inv: [], sku: "MISSING-LINK" },
      ])
    );
    const c = build({ graph });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(c.inventory.createInventoryItems).toHaveBeenCalledTimes(1);
    expect(c.remoteLink.create).toHaveBeenCalledTimes(1);
    expect(c.product.updateProductVariants).toHaveBeenCalledWith("var_1", {
      manage_inventory: true,
    });
    expect(c.inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: USA_LOC, stocked_quantity: 0 },
      { inventory_item_id: "iitem_new", location_id: USA_LOC, stocked_quantity: 0 },
    ]);
    expect(result.data).toEqual({
      created_inventory_item_ids: ["iitem_1", "iitem_new"],
      already_present: 0,
    });
  });

  it("accepts a race-created Miami level after createInventoryLevels fails", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: ["iitem_1"] }]));
    const inventory: Partial<InventoryMock> = {
      listInventoryLevels: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ inventory_item_id: "iitem_1" }]),
      createInventoryLevels: jest.fn().mockRejectedValue(new Error("duplicate key")),
    };
    const c = build({ graph, inventory });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(result.data).toEqual({
      created_inventory_item_ids: ["iitem_1"],
      already_present: 0,
    });
  });

  it("throws when creating a missing Miami level fails and remains missing", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: ["iitem_1"] }]));
    const inventory: Partial<InventoryMock> = {
      listInventoryLevels: jest.fn().mockResolvedValue([]),
      createInventoryLevels: jest.fn().mockRejectedValue(new Error("location disabled")),
    };
    const c = build({ graph, inventory });

    await expect(
      stepFn({ product_id: "prod_1", manage_inventory: true }, { container: c })
    ).rejects.toThrow("location disabled");
    expect(c.inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: USA_LOC, stocked_quantity: 0 },
    ]);
  });
});
