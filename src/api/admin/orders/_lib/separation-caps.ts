/**
 * Pure math for how many units of each order line may be marked "separated".
 *
 * The cap is PHYSICAL Miami inventory, never the raw reservation: reservations
 * are created with allow_backorder=true even at zero stock (allocate-items), so
 * reservation quantity can be air. A line may separate up to:
 *
 *   stock-backed reservation (its own claim actually covered by stock)
 *   + free unreserved stock of its inventory item (shared pool)
 *
 * and never more than its open order quantity (qty − fulfilled).
 *
 * Because the free pool and the stock backing are per INVENTORY ITEM while
 * requests come per LINE, a request set is validated together: lines of the
 * same item compete for the same pool.
 */

export interface SeparationLineInput {
  lineId: string;
  /** Order quantity of the line. */
  quantity: number;
  /** Fulfilled quantity (already out the door — not separable). */
  fulfilled: number;
  /** Active reservation quantity for this line (may be air-backed). */
  reserved: number;
  /** null when the variant has no inventory item (services, freeform). */
  inventoryItemId: string | null;
}

export interface InventorySnapshot {
  /** Miami stocked_quantity per inventory item. */
  stocked: number;
  /** Miami reserved_quantity across ALL orders per inventory item. */
  reservedAllOrders: number;
}

export interface SeparationCap {
  lineId: string;
  openQty: number;
  /** Portion of this line's reservation actually covered by stock. */
  stockBackedReserved: number;
  /** Max separable for this line assuming no sibling requests. */
  cap: number;
}

function nz(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function freePool(inv: InventorySnapshot): number {
  return Math.max(0, nz(inv.stocked) - nz(inv.reservedAllOrders));
}

function stockBackedReserved(
  line: SeparationLineInput,
  inv: InventorySnapshot | undefined
): number {
  if (!inv) return 0;
  const othersReserved = Math.max(0, nz(inv.reservedAllOrders) - nz(line.reserved));
  return Math.min(
    nz(line.reserved),
    Math.max(0, nz(inv.stocked) - othersReserved)
  );
}

/** Per-line separation ceilings (display + single-line validation). */
export function computeSeparationCaps(
  lines: SeparationLineInput[],
  inventory: Map<string, InventorySnapshot>
): SeparationCap[] {
  return lines.map((line) => {
    const inv = line.inventoryItemId
      ? inventory.get(line.inventoryItemId)
      : undefined;
    const openQty = Math.max(0, nz(line.quantity) - nz(line.fulfilled));
    const backed = stockBackedReserved(line, inv);
    const pool = inv ? freePool(inv) : 0;
    return {
      lineId: line.lineId,
      openQty,
      stockBackedReserved: backed,
      cap: Math.min(openQty, backed + pool),
    };
  });
}

export interface SeparationRejection {
  lineId: string;
  requested: number;
  cap: number;
  reason: "exceeds_open_qty" | "exceeds_physical_stock";
}

/**
 * Validate a full requested set. Lines sharing an inventory item compete for
 * its free pool, so the pool check runs over the SUM of what each line asks
 * beyond its own stock-backed reservation.
 */
export function validateSeparationRequest(
  lines: SeparationLineInput[],
  inventory: Map<string, InventorySnapshot>,
  requested: Map<string, number>
): SeparationRejection[] {
  const caps = new Map(computeSeparationCaps(lines, inventory).map((c) => [c.lineId, c]));
  const rejections: SeparationRejection[] = [];
  const poolDemand = new Map<string, number>();

  for (const line of lines) {
    const req = nz(requested.get(line.lineId) ?? 0);
    const cap = caps.get(line.lineId);
    if (!cap || req === 0) continue;
    if (req > cap.openQty) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: cap.openQty,
        reason: "exceeds_open_qty",
      });
      continue;
    }
    const beyondBacked = Math.max(0, req - cap.stockBackedReserved);
    if (beyondBacked > 0 && line.inventoryItemId) {
      poolDemand.set(
        line.inventoryItemId,
        (poolDemand.get(line.inventoryItemId) ?? 0) + beyondBacked
      );
    } else if (beyondBacked > 0) {
      // No inventory item → no physical stock can back it.
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: cap.stockBackedReserved,
        reason: "exceeds_physical_stock",
      });
    }
  }

  for (const [itemId, demand] of poolDemand) {
    const inv = inventory.get(itemId);
    const pool = inv ? freePool(inv) : 0;
    if (demand > pool) {
      for (const line of lines) {
        if (line.inventoryItemId !== itemId) continue;
        const req = nz(requested.get(line.lineId) ?? 0);
        const cap = caps.get(line.lineId);
        if (!cap || req <= cap.stockBackedReserved) continue;
        rejections.push({
          lineId: line.lineId,
          requested: req,
          cap: Math.min(cap.openQty, cap.stockBackedReserved + pool),
          reason: "exceeds_physical_stock",
        });
      }
    }
  }

  return rejections;
}
