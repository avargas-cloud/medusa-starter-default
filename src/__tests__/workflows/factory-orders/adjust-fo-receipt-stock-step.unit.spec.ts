/**
 * Unit tests for adjustFoReceiptStockStep (factory order receive → China).
 *
 * Since d158aeea the step no longer calls `inventoryService.adjustInventory`:
 * it issues a single guarded UPDATE via `atomicStockMove`, so the availability
 * check (`stocked + delta >= reserved` and `>= 0`) lives inside the statement's
 * WHERE clause and there is no read-check-write window. The inventory module is
 * still used to READ levels and to CREATE a missing one — those stay mocked on
 * the module; the move itself is asserted on the knex binding.
 *
 * Key behaviors under test:
 *   • delta>0, missing level → createInventoryLevels(@0) before the move
 *   • delta>0, existing level → no create
 *   • delta<0 below zero → guard rejects → throws, nothing created
 *   • delta<0 blocked by a reservation → RESERVED_BLOCK error
 *   • delta===0 → skipped entirely (no read, no move)
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

/**
 * `raw` stands in for the knex connection the step resolves as
 * `__pg_connection__`. rowCount 1 = the guarded UPDATE applied; rowCount 0 =
 * the guard in the WHERE clause refused the move.
 */
function build(inventory: InventoryMock, raw: jest.Mock) {
  return {
    resolve: jest.fn((key: string) => {
      if (key === Modules.INVENTORY) return inventory;
      if (key === "__pg_connection__") return { raw };
      return null;
    }),
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
  let raw: jest.Mock;

  beforeEach(() => {
    inventory = {
      listInventoryLevels: jest.fn(),
      createInventoryLevels: jest.fn().mockResolvedValue(undefined),
    };
    raw = jest.fn().mockResolvedValue({ rowCount: 1 });
  });

  it("creates a China level @0 before adjusting for a positive delta with no level", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]);

    const result = await stepFn(
      { location_id: CHINA, lines: [line(5)] },
      { container: build(inventory, raw) }
    );

    expect(inventory.createInventoryLevels).toHaveBeenCalledWith([
      { inventory_item_id: "iitem_1", location_id: CHINA, stocked_quantity: 0 },
    ]);

    // The move targets the right row with the right delta...
    const [sql, bindings] = raw.mock.calls[0];
    expect(sql).toMatch(/UPDATE inventory_level/);
    expect(bindings).toEqual([5, 5, "iitem_1", CHINA, 5, 5, 5]);
    // ...and writes the BigNumber mirror alongside the numeric column, which is
    // the whole reason this is a raw UPDATE and not a module call.
    expect(sql).toMatch(/raw_stocked_quantity/);

    expect(result.data.adjusted[0]).toMatchObject({ qty_at_apply_time: 0, new_stock: 5 });
  });

  it("does NOT create a level when one already exists", async () => {
    inventory.listInventoryLevels.mockResolvedValue([
      { inventory_item_id: "iitem_1", stocked_quantity: 8 },
    ]);

    const result = await stepFn(
      { location_id: CHINA, lines: [line(2)] },
      { container: build(inventory, raw) }
    );

    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
    expect(raw.mock.calls[0][1]).toEqual([2, 2, "iitem_1", CHINA, 2, 2, 2]);
    expect(result.data.adjusted[0]).toMatchObject({ qty_at_apply_time: 8, new_stock: 10 });
  });

  it("throws and does not create when a negative delta would go below zero", async () => {
    inventory.listInventoryLevels.mockResolvedValue([]); // preStock 0
    raw.mockResolvedValue({ rowCount: 0 }); // guard refused

    await expect(
      stepFn({ location_id: CHINA, lines: [line(-3)] }, { container: build(inventory, raw) })
    ).rejects.toThrow(/Cannot reduce qty/);

    expect(inventory.createInventoryLevels).not.toHaveBeenCalled();
    // The guard clause must be part of the statement — that is what makes the
    // refusal atomic rather than a check the step performs itself.
    expect(raw.mock.calls[0][0]).toMatch(/reserved_quantity/);
    expect(raw.mock.calls[0][1]).toHaveLength(7);
  });

  it("throws RESERVED_BLOCK when the reduction is refused by a reservation, not by zero", async () => {
    // stocked 10, reserved 8 → dropping 5 leaves 5, above zero but below the
    // reservation, so the guard refuses without the result being negative.
    inventory.listInventoryLevels.mockResolvedValue([
      { inventory_item_id: "iitem_1", stocked_quantity: 10, reserved_quantity: 8 },
    ]);
    raw.mockResolvedValue({ rowCount: 0 });

    await expect(
      stepFn({ location_id: CHINA, lines: [line(-5)] }, { container: build(inventory, raw) })
    ).rejects.toThrow(/RESERVED_BLOCK/);
  });

  it("skips lines with delta === 0", async () => {
    const result = await stepFn(
      { location_id: CHINA, lines: [line(0)] },
      { container: build(inventory, raw) }
    );

    expect(inventory.listInventoryLevels).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    expect(result.data.adjusted).toHaveLength(0);
  });
});
