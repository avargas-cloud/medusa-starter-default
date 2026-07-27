import {
  buildInventoryCountStockBaseline,
  calculateInventoryCountDelta,
} from "../../lib/inventory-count/stock-baseline";

describe("inventory count stock baseline", () => {
  it("caps a phantom reservation when on-hand is zero", () => {
    expect(buildInventoryCountStockBaseline(0, 20)).toEqual({
      onHand: 0,
      rawReserved: 20,
      effectiveReserved: 0,
      available: 0,
    });
  });

  it("caps the reserved rack at total physical on-hand", () => {
    expect(buildInventoryCountStockBaseline(10, 20)).toEqual({
      onHand: 10,
      rawReserved: 20,
      effectiveReserved: 10,
      available: 0,
    });
  });

  it("keeps valid available and reserved racks separate", () => {
    expect(buildInventoryCountStockBaseline(20, 10)).toEqual({
      onHand: 20,
      rawReserved: 10,
      effectiveReserved: 10,
      available: 10,
    });
  });

  it("preserves signed on-hand so a count can repair negative inventory", () => {
    expect(buildInventoryCountStockBaseline(-5, 20)).toEqual({
      onHand: -5,
      rawReserved: 20,
      effectiveReserved: 0,
      available: -5,
    });
  });
});

describe("inventory count delta by physical rack", () => {
  it("produces no delta for zero on-hand with phantom reservations", () => {
    const result = calculateInventoryCountDelta({
      onHand: 0,
      rawReserved: 20,
      countedAvailable: 0,
      countedReserved: 0,
    });

    expect(result.availableDelta).toBe(0);
    expect(result.reservedDelta).toBe(0);
    expect(result.delta).toBe(0);
  });

  it("produces no delta when all on-hand is in the reserved rack", () => {
    const result = calculateInventoryCountDelta({
      onHand: 10,
      rawReserved: 20,
      countedAvailable: 0,
      countedReserved: 10,
    });

    expect(result.availableDelta).toBe(0);
    expect(result.reservedDelta).toBe(0);
    expect(result.delta).toBe(0);
  });

  it("adds the two rack variances", () => {
    const result = calculateInventoryCountDelta({
      onHand: 20,
      rawReserved: 10,
      countedAvailable: 8,
      countedReserved: 9,
    });

    expect(result.availableDelta).toBe(-2);
    expect(result.reservedDelta).toBe(-1);
    expect(result.delta).toBe(-3);
  });

  it("repairs signed negative on-hand when both racks count zero", () => {
    const result = calculateInventoryCountDelta({
      onHand: -5,
      rawReserved: 20,
      countedAvailable: 0,
      countedReserved: 0,
    });

    expect(result.effectiveReserved).toBe(0);
    expect(result.delta).toBe(5);
  });
});
