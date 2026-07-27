export interface InventoryCountStockBaseline {
  onHand: number;
  rawReserved: number;
  effectiveReserved: number;
  available: number;
}

export interface InventoryCountDeltaInput {
  onHand: number;
  rawReserved: number;
  countedAvailable: number;
  countedReserved: number;
}

export interface InventoryCountDeltaResult extends InventoryCountStockBaseline {
  availableDelta: number;
  reservedDelta: number;
  delta: number;
}

/**
 * `stocked_quantity` is the total physical on-hand across both racks.
 * `reserved_quantity` is only an allocation cache and can temporarily exceed
 * on-hand, so it must be capped before it represents the reserved rack.
 */
export function buildInventoryCountStockBaseline(
  onHand: number,
  rawReserved: number
): InventoryCountStockBaseline {
  const effectiveReserved = Math.min(
    Math.max(rawReserved, 0),
    Math.max(onHand, 0)
  );

  return {
    onHand,
    rawReserved,
    effectiveReserved,
    available: onHand - effectiveReserved,
  };
}

/**
 * Compare each physical rack with its matching system baseline. The combined
 * result remains equal to total-counted minus total on-hand.
 */
export function calculateInventoryCountDelta(
  input: InventoryCountDeltaInput
): InventoryCountDeltaResult {
  const baseline = buildInventoryCountStockBaseline(
    input.onHand,
    input.rawReserved
  );
  const availableDelta = input.countedAvailable - baseline.available;
  const reservedDelta = input.countedReserved - baseline.effectiveReserved;

  return {
    ...baseline,
    availableDelta,
    reservedDelta,
    delta: availableDelta + reservedDelta,
  };
}
