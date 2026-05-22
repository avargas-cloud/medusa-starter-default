/**
 * Unit tests for adjustFoReceiptStockStep (factory order receive → China).
 *
 * Key behaviors under test:
 *   • delta>0, missing level → createInventoryLevels(@0) before adjust
 *   • delta>0, existing level → no create
 *   • delta<0 below zero → throws, no create, no adjust
 *   • delta===0 → skipped entirely
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

import { Modules } from "@medusajs/utils";
import { adjustFoReceiptStockStep } from "../../../workflows/factory-orders/steps/adjust-fo-receipt-stock-step";

interface InventoryMock {
  listInventoryLevels: jest.Mock;
  adjustInventory: jest.Mock;
  createInventoryLevels: jest.Mock;
}

type StepFn = (
  input: {
    location_id: string;
    lines: Array<{
      receipt_line_id: string;
      fo_line_id: string;
      inventory_item_id: string;
      delta: number;
    }>;
  },
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{ data: { adjusted: Array<Record<string, unknown>> } }>;

const stepFn = adjustFoReceiptStockStep as unknown as StepFn;
const CHINA = "sloc_china";

function build(inventory: InventoryMock) {
  return {
    resolve: jest.fn((key: string) =>
      key === Modules.INVENTORY ? inventory : null
    ),
  };
}

const line = (delta: number) => ({
  receipt_line_id: "rl_1",
  fo_line_id: "fol_1",
  inventory_item_id: "iitem_1",
  delta,
});

describe("adjustFoReceiptStockStep", () => {
  let inventory: InventoryMock;

  beforeEach(() => {
    inventory = {
      listInventoryLevels: jest.fn(),
      adjustInventory: jest.fn().mockResolvedValue(undefined),
      createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    };
  });

  it("creates a China level @0 before adjusting for a positive delta with no level", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]);

    const result = await stepFn(
      { location_id: CHINA, lines: [line(5)] },
      { container: build(inventory) }
    );

    expect(inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: CHINA, stocked_quantity: 0 },
    ]);
    expect(inventory.adjustInventory).toHaveBeenCalledWith("iitem_1", CHINA, 5);
    expect(result.data.adjusted[0]).toMatchObject({ qty_at_apply_time: 0, new_stock: 5 });
  });

  it("does NOT create a level when one already exists", async () => {
    inventory.listInventoryLevels.mockResolvedValue([
      { inventory_item_id: "iitem_1", stocked_quantity: 8 },
    ]);

    await stepFn({ location_id: CHINA, lines: [line(2)] }, { container: build(inventory) });

    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(inventory.adjustInventory).toHaveBeenCalledWith("iitem_1", CHINA, 2);
  });

  it("throws and does not create/adjust when a negative delta would go below zero", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]); // preStock 0

    await expect(
      stepFn({ location_id: CHINA, lines: [line(-3)] }, { container: build(inventory) })
    ).rejects.toThrow(/Cannot reduce qty/);

    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(inventory.adjustInventory).not.toHaveBeenCalled();
  });

  it("skips lines with delta === 0", async () => {
    const result = await stepFn(
      { location_id: CHINA, lines: [line(0)] },
      { container: build(inventory) }
    );

    expect(inventory.listInventoryLevels).not.toHaveBeenCalled();
    expect(inventory.adjustInventory).not.toHaveBeenCalled();
    expect(result.data.adjusted).toHaveLength(0);
  });
});
