/**
 * Unit tests for ensureMiamiLevelsStep (create-pos-product-v2).
 *
 * Key behaviors under test:
 *   • manage_inventory false → no-op (no query, no writes)
 *   • empty product_id → no-op
 *   • product not found → warn, no writes
 *   • creates Miami level @0 only for inventory items missing one (idempotent)
 *   • no inventory items resolved → no-op
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

import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { USA_LOC } from "../../../lib/locations";
import { ensureMiamiLevelsStep } from "../../../workflows/pos/steps/ensure-miami-levels-step";

interface InventoryMock {
  listInventoryLevels: jest.Mock;
  createInventoryLevels: jest.Mock;
}

type StepFn = (
  input: { product_id: string; manage_inventory: boolean },
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{ data: { created_inventory_item_ids: string[]; already_present: number } }>;

const stepFn = ensureMiamiLevelsStep as unknown as StepFn;

function build(opts: { graph?: jest.Mock; inventory?: InventoryMock }) {
  const query = { graph: opts.graph ?? jest.fn() };
  const inventory =
    opts.inventory ?? {
      listInventoryLevels: jest.fn().mockResolvedValue([]),
      createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    };
  const logger = { info: jest.fn(), warn: jest.fn() };
  return {
    resolve: jest.fn((key: string) => {
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === Modules.INVENTORY) return inventory;
      if (key === "logger") return logger;
      return null;
    }),
    query,
    inventory,
    logger,
  };
}

const productGraph = (variants: Array<{ inv: string[] }>) => ({
  data: [
    {
      id: "prod_1",
      variants: variants.map((v, i) => ({
        id: `var_${i}`,
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
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(result.data).toEqual({ created_inventory_item_ids: [], already_present: 0 });
  });

  it("is a no-op when product_id is empty", async () => {
    const c = build({});
    await stepFn({ product_id: "", manage_inventory: true }, { container: c });
    expect(c.query.graph).not.toHaveBeenCalled();
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
  });

  it("warns and writes nothing when the product is not found", async () => {
    const graph = jest.fn().mockResolvedValue({ data: [] });
    const c = build({ graph });
    const result = await stepFn(
      { product_id: "prod_x", manage_inventory: true },
      { container: c }
    );
    expect(c.logger.warn).toHaveBeenCalledWith(expect.stringContaining("prod_x"));
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(result.data).toEqual({ created_inventory_item_ids: [], already_present: 0 });
  });

  it("creates a Miami level @0 only for items missing one", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: ["iitem_1", "iitem_2"] }]));
    const inventory: InventoryMock = {
      // iitem_2 already has a Miami level → only iitem_1 should be created
      listInventoryLevels: jest.fn().mockResolvedValue([{ inventory_item_id: "iitem_2" }]),
      createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    };
    const c = build({ graph, inventory });

    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );

    expect(inventory.createInventoryLevels).toHaveBeenCalledTimes(1);
    expect(inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: USA_LOC, stocked_quantity: 0 },
    ]);
    expect(result.data).toEqual({
      created_inventory_item_ids: ["iitem_1"],
      already_present: 1,
    });
  });

  it("is a no-op when the product has no inventory items", async () => {
    const graph = jest.fn().mockResolvedValue(productGraph([{ inv: [] }]));
    const c = build({ graph });
    const result = await stepFn(
      { product_id: "prod_1", manage_inventory: true },
      { container: c }
    );
    expect(c.inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(result.data).toEqual({ created_inventory_item_ids: [], already_present: 0 });
  });
});
