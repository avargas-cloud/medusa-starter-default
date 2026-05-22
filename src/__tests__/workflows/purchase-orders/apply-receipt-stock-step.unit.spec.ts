/**
 * Unit tests for applyReceiptStockStep (PO receive → Miami).
 *
 * Key behaviors under test:
 *   • Missing level → createInventoryLevels(@0) BEFORE adjustInventory
 *   • Existing level → does NOT create; uses its stock as preStock
 *   • qty_received_now <= 0 → throws
 *   • Multiple lines → one adjust per line, correct applied deltas
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
import { applyReceiptStockStep } from "../../../workflows/purchase-orders/steps/apply-receipt-stock-step";

interface InventoryMock {
  listInventoryLevels: jest.Mock;
  adjustInventory: jest.Mock;
  createInventoryLevels: jest.Mock;
}

type StepFn = (
  input: {
    location_id: string;
    lines: Array<{
      po_line_id: string;
      inventory_item_id: string;
      qty_received_now: number;
    }>;
  },
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{ data: { applied: Array<Record<string, unknown>> } }>;

const stepFn = applyReceiptStockStep as unknown as StepFn;

function build(inventory: InventoryMock) {
  return {
    resolve: jest.fn((key: string) =>
      key === Modules.INVENTORY ? inventory : null
    ),
  };
}

const MIAMI = "sloc_miami";

describe("applyReceiptStockStep", () => {
  let inventory: InventoryMock;

  beforeEach(() => {
    inventory = {
      listInventoryLevels: jest.fn(),
      adjustInventory: jest.fn().mockResolvedValue(undefined),
      createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    };
  });

  it("creates a Miami level @0 BEFORE adjusting when none exists", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]); // no level

    const result = await stepFn(
      {
        location_id: MIAMI,
        lines: [{ po_line_id: "pol_1", inventory_item_id: "iitem_1", qty_received_now: 3 }],
      },
      { container: build(inventory) }
    );

    expect(inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: MIAMI, stocked_quantity: 0 },
    ]);
    expect(inventory.adjustInventory).toHaveBeenCalledWith("iitem_1", MIAMI, 3);
    // creation must precede adjustment
    expect(inventory.createInventoryLevels.mock.invocationCallOrder[0]).toBeLessThan(
      inventory.adjustInventory.mock.invocationCallOrder[0]
    );
    expect(result.data.applied[0]).toMatchObject({
      po_line_id: "pol_1",
      qty_applied: 3,
      qty_at_apply_time: 0,
      new_stock: 3,
    });
  });

  it("does NOT create a level when one already exists", async () => {
    inventory.listInventoryLevels.mockResolvedValue([
      { inventory_item_id: "iitem_1", stocked_quantity: 40 },
    ]);

    const result = await stepFn(
      {
        location_id: MIAMI,
        lines: [{ po_line_id: "pol_1", inventory_item_id: "iitem_1", qty_received_now: 5 }],
      },
      { container: build(inventory) }
    );

    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(inventory.adjustInventory).toHaveBeenCalledWith("iitem_1", MIAMI, 5);
    expect(result.data.applied[0]).toMatchObject({
      qty_at_apply_time: 40,
      new_stock: 45,
    });
  });

  it("throws when qty_received_now <= 0", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]);

    await expect(
      stepFn(
        {
          location_id: MIAMI,
          lines: [{ po_line_id: "pol_1", inventory_item_id: "iitem_1", qty_received_now: 0 }],
        },
        { container: build(inventory) }
      )
    ).rejects.toThrow(/must be > 0/);

    expect(inventory.adjustInventory).not.toHaveBeenCalled();
    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
  });

  it("handles multiple lines independently (one creates, one exists)", async () => {
    inventory.listInventoryLevels
      .mockResolvedValueOnce([]) // line 1 missing
      .mockResolvedValueOnce([{ inventory_item_id: "iitem_2", stocked_quantity: 10 }]); // line 2 exists

    const result = await stepFn(
      {
        location_id: MIAMI,
        lines: [
          { po_line_id: "pol_1", inventory_item_id: "iitem_1", qty_received_now: 2 },
          { po_line_id: "pol_2", inventory_item_id: "iitem_2", qty_received_now: 4 },
        ],
      },
      { container: build(inventory) }
    );

    expect(inventory.createInventoryLevels).toHaveBeenCalledTimes(1);
    expect(inventory.adjustInventory).toHaveBeenCalledTimes(2);
    expect(result.data.applied).toHaveLength(2);
    expect(result.data.applied[1]).toMatchObject({ qty_at_apply_time: 10, new_stock: 14 });
  });
});
