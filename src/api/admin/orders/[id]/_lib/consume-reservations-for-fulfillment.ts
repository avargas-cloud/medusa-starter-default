/**
 * Proportional reservation consumption + stock decrement for the NON-native
 * fulfillment paths — the manual equivalent of what
 * createOrderFulfillmentWorkflow does internally (adjustInventoryLevelsStep +
 * reservation delete/decrement).
 *
 * Used by:
 *   - create-fulfillment-force Strategy 2 (native workflow bypassed)
 *   - complete-pickup fallback (fulfillmentModule.createFulfillment direct)
 *
 * Rules (2026-07-10 apartado policy — reservations survive invoicing, so a
 * partial fulfillment must NEVER over-release the remainder):
 *   - Consume the fulfilled quantity from the line's active reservations,
 *     oldest first. A reservation fully consumed is deleted; a partially
 *     consumed one is decremented (module API keeps reserved_quantity cache
 *     and raw_* BigNumbers in sync and fires the Meili PG trigger).
 *   - Stock is decremented by exactly the fulfilled quantity via
 *     adjustInventory (numeric + raw_ in sync).
 *   - Best-effort per line (warn, never throw) — parity with both callers.
 *
 * Returns the affected inventory_item_ids so callers can run the inline
 * Meili sync workflow (belt-and-suspenders; the PG trigger is the backstop).
 */

export interface ConsumeReservationItem {
  /** order_line_item id (ordli_) */
  line_item_id: string;
  /** quantity being fulfilled */
  quantity: number;
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export async function consumeReservationsForFulfillment(opts: {
  pool: PgPool;
  inventoryModule: any;
  locationId: string;
  items: ConsumeReservationItem[];
  logPrefix?: string;
}): Promise<string[]> {
  const { pool, inventoryModule, locationId, items } = opts;
  const logPrefix = opts.logPrefix ?? "[consume-reservations]";
  const affected: string[] = [];

  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) continue;
    try {
      // Resolve the inventory item via the line's variant (lines without a
      // variant/inventory link — services, comments — are skipped).
      const invRes = await pool.query(
        `SELECT pvii.inventory_item_id
           FROM order_line_item oli
           JOIN product_variant_inventory_item pvii
             ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
          WHERE oli.id = $1
          LIMIT 1`,
        [item.line_item_id]
      );
      const inventoryItemId: string | undefined =
        invRes.rows[0]?.inventory_item_id;
      if (!inventoryItemId) continue;

      // Active reservations, oldest first. Raw SQL because the module's
      // { line_item_id } filter is unreliable in Medusa v2 (may return empty
      // when rows exist).
      const resv = await pool.query(
        `SELECT id, quantity FROM reservation_item
          WHERE line_item_id = $1 AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        [item.line_item_id]
      );

      let remaining = item.quantity;
      for (const r of resv.rows) {
        if (remaining <= 0) break;
        const resQty = Number(r.quantity);
        const take = Math.min(resQty, remaining);
        if (take >= resQty) {
          await inventoryModule.deleteReservationItems([r.id]);
        } else {
          await inventoryModule.updateReservationItems([
            { id: r.id, quantity: resQty - take },
          ]);
        }
        remaining -= take;
      }

      // Decrement physical stock by the fulfilled quantity.
      await inventoryModule.adjustInventory(
        inventoryItemId,
        locationId,
        -item.quantity
      );
      affected.push(inventoryItemId);
      console.log(
        `${logPrefix} ✅ consumed ${item.quantity} (reservations + stock) for line ${item.line_item_id}`
      );
    } catch (err: any) {
      console.warn(
        `${logPrefix} failed for line ${item.line_item_id}: ${err?.message?.slice(0, 120)}`
      );
    }
  }
  return affected;
}
