/**
 * Pure math for how many units of each order line may be marked "separated".
 *
 * Since 2026-08-12 the cross-order arbiter is the SEPARATION itself, not the
 * reservation (owner decision): reservations are created with
 * allow_backorder=true even at zero stock (allocate-items), so reservation
 * quantity can be air — and stock sitting unseparated on the shelf covers
 * nobody. A line may separate up to
 *
 *   Miami stocked
 *   − live separations of OTHER orders (their unfulfilled remainder)
 *   − stored separations of SIBLING lines (same inventory item, same order)
 *
 * and never more than its open order quantity (qty − fulfilled).
 *
 * A separation is LIVE while its work is pending: max(0, qty − fulfilled) in a
 * non-canceled, non-archived order. Delivered units left the building and
 * release their claim; invoiced-but-undelivered ones still hold it.
 *
 * A stored value the stock no longer backs is never forced down (the units are
 * already on the shelf) — the cap only limits RAISING: any request at or below
 * the line's stored separation always passes.
 */

export interface SeparationLineInput {
  lineId: string;
  /** Order quantity of the line. */
  quantity: number;
  /** Fulfilled quantity (already out the door — not separable). */
  fulfilled: number;
  /** Active reservation quantity for this line — display fact only; plays no
   *  role in the cap since 2026-08-12. */
  reserved: number;
  /** null when the variant has no inventory item (services, freeform). */
  inventoryItemId: string | null;
  /** Stored separation of this line (total, not delta). */
  separated: number;
}

export interface InventorySnapshot {
  /** Miami stocked_quantity per inventory item. */
  stocked: number;
  /** Miami reserved_quantity across ALL orders — display fact only. */
  reservedAllOrders: number;
  /** Live separations of OTHER orders for this item: Σ max(0, qty − fulfilled)
   *  over their lines, canceled/archived orders excluded. */
  separatedElsewhere: number;
}

export interface SeparationCap {
  lineId: string;
  openQty: number;
  /** Max separable for this line assuming no sibling requests raise theirs. */
  cap: number;
}

function nz(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Stock left for this ORDER to separate: what other orders' live separations
 *  have not already claimed. */
function orderPool(inv: InventorySnapshot): number {
  return Math.max(0, nz(inv.stocked) - nz(inv.separatedElsewhere));
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
    if (!inv) return { lineId: line.lineId, openQty, cap: 0 };
    // Sibling lines' STORED separations are hard demand on the same pool; the
    // line's own stored value is not demand against itself (qty is a total).
    const siblingStored = lines.reduce(
      (acc, l) =>
        l.lineId !== line.lineId && l.inventoryItemId === line.inventoryItemId
          ? acc + nz(l.separated)
          : acc,
      0
    );
    return {
      lineId: line.lineId,
      openQty,
      cap: Math.min(openQty, Math.max(0, orderPool(inv) - siblingStored)),
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
 * its pool with their TOTAL requested value; lines the request does not
 * mention still occupy the pool with their stored separation. Lowering or
 * keeping a stored value is always allowed — only raises are gated.
 */
export function validateSeparationRequest(
  lines: SeparationLineInput[],
  inventory: Map<string, InventorySnapshot>,
  requested: Map<string, number>
): SeparationRejection[] {
  const rejections: SeparationRejection[] = [];
  // Effective claim per line: the requested total when mentioned, the stored
  // separation otherwise.
  const effective = (l: SeparationLineInput): number =>
    requested.has(l.lineId) ? nz(requested.get(l.lineId) ?? 0) : nz(l.separated);

  const overdrawnItems = new Set<string>();
  const demandByItem = new Map<string, number>();
  for (const l of lines) {
    if (!l.inventoryItemId) continue;
    demandByItem.set(
      l.inventoryItemId,
      (demandByItem.get(l.inventoryItemId) ?? 0) + effective(l)
    );
  }
  for (const [itemId, demand] of demandByItem) {
    const inv = inventory.get(itemId);
    if (demand > (inv ? orderPool(inv) : 0)) overdrawnItems.add(itemId);
  }

  for (const line of lines) {
    if (!requested.has(line.lineId)) continue;
    const req = nz(requested.get(line.lineId) ?? 0);
    const stored = nz(line.separated);
    // Never force lowering: at or below the stored value there is nothing to
    // authorize — those units are already on the shelf.
    if (req <= stored) continue;

    const openQty = Math.max(0, nz(line.quantity) - nz(line.fulfilled));
    if (req > openQty) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: openQty,
        reason: "exceeds_open_qty",
      });
      continue;
    }

    if (!line.inventoryItemId) {
      // No inventory item → no physical stock can back a raise.
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: Math.min(openQty, stored),
        reason: "exceeds_physical_stock",
      });
      continue;
    }

    if (overdrawnItems.has(line.inventoryItemId)) {
      const inv = inventory.get(line.inventoryItemId);
      const pool = inv ? orderPool(inv) : 0;
      const othersClaim = lines.reduce(
        (acc, l) =>
          l.lineId !== line.lineId &&
          l.inventoryItemId === line.inventoryItemId
            ? acc + effective(l)
            : acc,
        0
      );
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: Math.min(openQty, Math.max(0, pool - othersClaim)),
        reason: "exceeds_physical_stock",
      });
    }
  }

  return rejections;
}
