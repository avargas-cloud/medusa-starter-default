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
 * non-canceled, non-archived order. Fulfilled units left the building and
 * release their claim; invoiced-but-unfulfilled ones still hold it.
 *
 * `fulfilled` here means UNITS COVERED BY A LIVE FULFILLMENT — never
 * `order_item.fulfilled_quantity`, which is an aggregate Medusa does not
 * revert when a fulfillment is canceled and deleted (see separation-data.ts).
 * Invoicing does NOT cover anything: a paid invoice whose goods are still
 * waiting on the shelf for pickup is exactly the case separation exists for
 * (owner decision 2026-08-20, replacing the 2026-08-11 one that folded
 * invoiced units into "done").
 *
 * A stored value the stock no longer backs is never forced down (the units are
 * already on the shelf) — the cap only limits RAISING: any request at or below
 * the line's stored separation always passes.
 *
 * The mirror rule is the FLOOR: units already invoiced and not yet fulfilled
 * are promised to a customer who has been billed for them, so they may never
 * be un-separated. That floor is independent of stock — it states demand, not
 * availability, and a line whose floor exceeds its physical cap is a real
 * fact the warehouse needs to see, not an error to hide.
 */

export interface SeparationLineInput {
  lineId: string;
  /** Order quantity of the line. */
  quantity: number;
  /** Units covered by a LIVE fulfillment — already out the door, not
   *  separable. Never `order_item.fulfilled_quantity`. */
  fulfilled: number;
  /** Units on active (non-voided, non-draft) POS invoices. Does NOT cover the
   *  line — it only sets the floor below which the separation cannot drop. */
  invoiced: number;
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
  /** What STOCK backs right now: Miami stock net of every other claim, capped
   *  at the pending quantity. A warning and a list badge — NOT the ceiling. */
  cap: number;
  /** Minimum the separation may never drop below: invoiced units still in the
   *  warehouse. Zero when nothing is invoiced or everything was fulfilled. */
  invoicedFloor: number;
  /** The ceiling the operator may actually type: pending units net of what
   *  other orders and sibling lines already claim. Never below the floor. */
  maxSeparable: number;
}

function nz(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Si la línea participa de la separación.
 *
 * Apartar es un acto FÍSICO: alguien mueve unidades a un estante. Una línea que
 * no rastrea inventario —un servicio de instalación, un cargo de expedite, una
 * línea freeform— no tiene unidades que mover, así que no se muestra, no se
 * aparta y no cuenta para el estado de la orden.
 *
 * El predicado es la AUSENCIA DE INVENTORY ITEM, no `metadata.quickbooks_is_service`.
 * Ese flag existe para otra cosa (no emitir `<InventorySiteRef>` en el QBXML y
 * esquivar el error 3140), se mantiene a mano, y medido sobre las 6.505 líneas
 * de órdenes vivas cubre 36 de las 44 no-físicas: se le escapan
 * `Services:Assembly-Panels`, `Services:Installation-On-Site` y `Expedite`.
 * Colgar una regla de depósito de él haría que cada servicio nuevo sin flaggear
 * reapareciera en el modal. `manage_inventory = false` y "sin inventory item"
 * coinciden hoy en las 6.505 sin una sola discrepancia.
 *
 * Va por la NEGATIVA a propósito: lo excepcional es no tener inventario, así que
 * una línea a la que le falte el `product_variant_inventory_item` por error se
 * escondería en vez de mostrarse con stock 0. Hoy no existe ninguna (cero líneas
 * con `manage_inventory = true` y sin inventory item), y el E2E lo vigila con una
 * assertion negativa: una línea física SIN STOCK sigue apareciendo y sigue siendo
 * separable.
 */
export function isSeparableLine(line: SeparationLineInput): boolean {
  return line.inventoryItemId !== null;
}

/**
 * Las líneas que cuentan para el `separation_status` de la orden.
 *
 * Vive acá y no en `separation-status.ts` porque el filtro es del DOMINIO de la
 * separación, no de la derivación: `deriveSeparationStatus` sigue siendo una
 * función pura sobre las líneas que le den. Lo comparten la ruta de escritura y
 * `clearDeliveredSeparations` — si cada una filtrara por su cuenta, guardar el
 * modal y despachar podrían dejar estados distintos sobre los mismos datos.
 *
 * Sin esto, una orden con una línea de servicio JAMÁS llega a `full`: el
 * servicio aporta su pendiente y nadie puede apartarlo.
 */
export function separationStatusLinesOf<T extends SeparationLineInput>(
  lines: T[]
): T[] {
  return lines.filter(isSeparableLine);
}

/** Pending units of a line: what still needs warehouse work. */
export function openQtyOf(line: SeparationLineInput): number {
  return Math.max(0, nz(line.quantity) - nz(line.fulfilled));
}

/**
 * Invoiced units of the line that have NOT left the warehouse — the floor the
 * separation may never go under. Clamped to the pending quantity so an
 * over-invoiced line can never demand more than the order asks for.
 */
export function invoicedFloorOf(line: SeparationLineInput): number {
  const invoicedInOrder = Math.min(nz(line.invoiced), nz(line.quantity));
  return Math.min(
    openQtyOf(line),
    Math.max(0, invoicedInOrder - nz(line.fulfilled))
  );
}

/**
 * Separated units of the line as every surface must count them: the stored
 * separation OR the invoiced floor, whichever is higher — the same `max` the
 * modal renders per row. The floor is a promise (billed, not yet out the
 * door), so a line covered only by invoices counts as set aside even with no
 * physical row.
 *
 * This is the ONLY value `deriveSeparationStatus` may be fed as `separated`.
 * Its three callers used to pass the stored value raw, so an order whose
 * open units were partly covered by invoices alone stamped `partial` while
 * the modal showed everything set aside and the list badge said full —
 * S11432/3021 wore all three at once.
 */
export function effectiveSeparatedOf(line: SeparationLineInput): number {
  return Math.max(nz(line.separated), invoicedFloorOf(line));
}

/** Stock left for this ORDER to separate: what other orders' live separations
 *  have not already claimed. */
function orderPool(inv: InventorySnapshot): number {
  return Math.max(0, nz(inv.stocked) - nz(inv.separatedElsewhere));
}

/** Σ stored separations of OTHER lines of THIS order on the same item. Hard
 *  demand on the same units; the line's own stored value is not demand against
 *  itself (its qty is a total, not a delta). */
function siblingStoredOf(
  line: SeparationLineInput,
  lines: SeparationLineInput[]
): number {
  return lines.reduce(
    (acc, l) =>
      l.lineId !== line.lineId && l.inventoryItemId === line.inventoryItemId
        ? acc + nz(l.separated)
        : acc,
    0
  );
}

/**
 * The ceiling the operator may type (owner decision 2026-08-20).
 *
 * NOT stock-backed. `stocked_quantity` is the system's belief about the shelf,
 * and the operator marking a separation is LOOKING at the shelf — when the two
 * disagree the count is the thing that is wrong, and a screen that refuses the
 * real number just makes the discrepancy invisible. S11432 is the case:
 * `stocked_quantity` said 1 while 18 units sat invoiced and waiting for pickup,
 * so a stock ceiling pinned the row at a value it could not leave.
 *
 * What still binds is other people's claims — the cross-order arbiter of
 * 2026-08-12 is intact: units another order has separated, and units a sibling
 * line of this order has separated, are not available to take. Stock survives
 * as `cap` below: a WARNING the row paints amber, never a refusal.
 */
function maxSeparableOf(
  line: SeparationLineInput,
  lines: SeparationLineInput[],
  inv: InventorySnapshot | undefined
): number {
  const openQty = openQtyOf(line);
  const claimedElsewhere = inv ? nz(inv.separatedElsewhere) : 0;
  return Math.max(
    invoicedFloorOf(line),
    Math.max(0, openQty - claimedElsewhere - siblingStoredOf(line, lines))
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
    const openQty = openQtyOf(line);
    // Una línea que no rastrea inventario no tiene nada que apartar: todos sus
    // topes son 0. `openQty` se deja VERAZ — el mismo campo lo lee el modal de
    // Product Status para decir cuánto falta que llegue, y ahí un servicio
    // pendiente sigue siendo un hecho.
    if (!isSeparableLine(line))
      return {
        lineId: line.lineId,
        openQty,
        cap: 0,
        invoicedFloor: 0,
        maxSeparable: 0,
      };
    const floor = invoicedFloorOf(line);
    const maxSeparable = maxSeparableOf(line, lines, inv);
    if (!inv)
      return {
        lineId: line.lineId,
        openQty,
        cap: 0,
        invoicedFloor: floor,
        maxSeparable,
      };
    const siblingStored = siblingStoredOf(line, lines);
    return {
      lineId: line.lineId,
      openQty,
      // Stock-backed: what the warehouse could set aside RIGHT NOW without
      // contradicting the count. Drives the list's "available" badge and the
      // amber warning — no longer the input's ceiling.
      cap: Math.min(openQty, Math.max(0, orderPool(inv) - siblingStored)),
      invoicedFloor: floor,
      maxSeparable,
    };
  });
}

export interface SeparationRejection {
  lineId: string;
  requested: number;
  cap: number;
  reason:
    | "exceeds_open_qty"
    | "exceeds_claimed_elsewhere"
    | "below_invoiced_floor"
    | "not_separable";
}

/**
 * Validate a full requested set.
 *
 * RAISES are gated by other people's claims, not by the stock count (owner
 * decision 2026-08-20 — see maxSeparableOf). DROPS are gated by the invoiced
 * floor. The screen clamps both, but a POST is not a screen and re-validates
 * here.
 *
 * Lines sharing an inventory item compete with their TOTAL requested value;
 * lines the request does not mention still hold their stored separation.
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

  for (const line of lines) {
    if (!requested.has(line.lineId)) continue;
    const req = nz(requested.get(line.lineId) ?? 0);
    const stored = nz(line.separated);

    // Una línea sin inventario no se aparta ni siquiera en 0: mencionarla en el
    // request significa que quien llamó cree que se puede, y la pantalla ya no
    // la muestra. La ruta es la autorización, así que lo dice acá y no confía en
    // que el modal haya filtrado.
    if (!isSeparableLine(line)) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: 0,
        reason: "not_separable",
      });
      continue;
    }

    // Invoiced units still in the warehouse can never be un-separated: the
    // customer was billed for them and they are waiting to be picked up.
    const floor = invoicedFloorOf(line);
    if (req < floor) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: floor,
        reason: "below_invoiced_floor",
      });
      continue;
    }

    // Nothing to authorize at or below what the line ALREADY holds — the
    // stored separation (those units are on the shelf) or the invoiced floor
    // (those units are billed and cannot leave it). The floor has to clear the
    // stock check too, or a line demanding 18 and backed by 1 unit of stock is
    // refused for being under the floor at 0 AND over the stock at 18: an
    // unsaveable row. When the two disagree the discrepancy is in the
    // warehouse, and the modal's job is to show it, not to arbitrate it.
    if (req <= Math.max(stored, floor)) continue;

    const openQty = openQtyOf(line);
    if (req > openQty) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: openQty,
        reason: "exceeds_open_qty",
      });
      continue;
    }

    // What is left after everyone else's claim. Sibling lines of THIS order
    // count with their EFFECTIVE value (a request that raises two lines of the
    // same item at once must not let both spend the same units), other orders
    // with their live separation.
    const inv = line.inventoryItemId
      ? inventory.get(line.inventoryItemId)
      : undefined;
    const claimedElsewhere = inv ? nz(inv.separatedElsewhere) : 0;
    const siblingsClaim = lines.reduce(
      (acc, l) =>
        l.lineId !== line.lineId && l.inventoryItemId === line.inventoryItemId
          ? acc + effective(l)
          : acc,
      0
    );
    const ceiling = Math.max(
      floor,
      Math.max(0, openQty - claimedElsewhere - siblingsClaim)
    );
    if (req > ceiling) {
      rejections.push({
        lineId: line.lineId,
        requested: req,
        cap: ceiling,
        reason: "exceeds_claimed_elsewhere",
      });
    }
  }

  return rejections;
}
