/**
 * Pure math of per-line separation: physical caps and the derived tri-state.
 *
 * The cases that matter and cannot be trusted to a green sandbox run:
 *  - an air-backed reservation (allow_backorder at zero stock) grants NO cap;
 *  - two lines of the same inventory item competing for one free pool;
 *  - the legacy boolean (is_separated with no rows) still reads as full.
 */

import {
  computeSeparationCaps,
  validateSeparationRequest,
  type InventorySnapshot,
  type SeparationLineInput,
} from "../../api/admin/orders/_lib/separation-caps";
import { deriveSeparationStatus } from "../../api/admin/orders/_lib/separation-status";

const inv = (stocked: number, reservedAllOrders: number): InventorySnapshot => ({
  stocked,
  reservedAllOrders,
});

const line = (
  overrides: Partial<SeparationLineInput> & { lineId: string }
): SeparationLineInput => ({
  quantity: 0,
  fulfilled: 0,
  reserved: 0,
  inventoryItemId: "iitem_a",
  ...overrides,
});

describe("computeSeparationCaps", () => {
  it("caps at open qty when stock is plentiful", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 7, fulfilled: 2, reserved: 5 })],
      new Map([["iitem_a", inv(100, 5)]])
    );
    expect(caps[0]).toMatchObject({ openQty: 5, stockBackedReserved: 5, cap: 5 });
  });

  it("an air-backed reservation grants no cap", () => {
    // Reserved 7 but zero stock — allow_backorder reservation is air.
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 7, reserved: 7 })],
      new Map([["iitem_a", inv(0, 7)]])
    );
    expect(caps[0]).toMatchObject({ stockBackedReserved: 0, cap: 0 });
  });

  it("stock claimed by OTHER orders does not back this line", () => {
    // 4 in stock, 10 reserved in total of which 6 belong to others: others'
    // claim eats all 4 → this line's reservation is fully at risk.
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 4, reserved: 4 })],
      new Map([["iitem_a", inv(4, 10)]])
    );
    expect(caps[0].stockBackedReserved).toBe(0);
    expect(caps[0].cap).toBe(0);
  });

  it("free unreserved stock extends the cap beyond the reservation", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 10, reserved: 2 })],
      new Map([["iitem_a", inv(9, 2)]])
    );
    // backed 2 + free pool 7 = 9, capped by openQty 10 → 9
    expect(caps[0].cap).toBe(9);
  });

  it("a line with no inventory item cannot separate", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 3, inventoryItemId: null })],
      new Map()
    );
    expect(caps[0].cap).toBe(0);
  });
});

describe("validateSeparationRequest", () => {
  it("accepts a request within the cap", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 7, reserved: 3 })],
      new Map([["iitem_a", inv(10, 3)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([]);
  });

  it("rejects beyond open qty", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 7, fulfilled: 3, reserved: 7 })],
      new Map([["iitem_a", inv(100, 7)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([
      { lineId: "l1", requested: 5, cap: 4, reason: "exceeds_open_qty" },
    ]);
  });

  it("two lines of the same item compete for one free pool", () => {
    // Pool: 5 stocked, 0 reserved → 5 free. Each line alone could take 5,
    // together they ask 8 → both rejected with the shared honest cap.
    const lines = [
      line({ lineId: "l1", quantity: 6 }),
      line({ lineId: "l2", quantity: 6 }),
    ];
    const inventory = new Map([["iitem_a", inv(5, 0)]]);
    const rejections = validateSeparationRequest(
      lines,
      inventory,
      new Map([
        ["l1", 4],
        ["l2", 4],
      ])
    );
    expect(rejections.map((r) => r.lineId).sort()).toEqual(["l1", "l2"]);
    expect(rejections.every((r) => r.reason === "exceeds_physical_stock")).toBe(true);
  });

  it("stock-backed reservations do not draw from the pool", () => {
    // 5 stocked, 5 reserved (all this line's) → backed 5, pool 0. Asking the
    // backed amount is fine even with an empty pool.
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 5, reserved: 5 })],
      new Map([["iitem_a", inv(5, 5)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([]);
  });
});

describe("deriveSeparationStatus", () => {
  it("none when nothing separated and no legacy flag", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 0 }], false)
    ).toBe("none");
  });

  it("legacy boolean with no rows reads as full", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 0 }], true)
    ).toBe("full");
  });

  it("partial when some open qty is separated", () => {
    expect(
      deriveSeparationStatus(
        [
          { quantity: 5, fulfilled: 0, separated: 5 },
          { quantity: 3, fulfilled: 0, separated: 0 },
        ],
        false
      )
    ).toBe("partial");
  });

  it("full when every open line is covered", () => {
    expect(
      deriveSeparationStatus(
        [
          { quantity: 5, fulfilled: 0, separated: 5 },
          { quantity: 3, fulfilled: 3, separated: 0 }, // fulfilled needs nothing
        ],
        false
      )
    ).toBe("full");
  });

  it("rows win over the legacy flag once they exist", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 2 }], true)
    ).toBe("partial");
  });

  it("over-separated rows clamp to open qty (still full, never >100%)", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 2, separated: 5 }], false)
    ).toBe("full");
  });
});
