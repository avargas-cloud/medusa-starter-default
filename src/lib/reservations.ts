/**
 * Raw-SQL reservation reads.
 *
 * `inventoryModule.listReservationItems({ line_item_id })` is UNRELIABLE in
 * Medusa v2 (may return [] even when rows exist — documented first in
 * invoices/[id]/void). Any existence/idempotency check that gates reservation
 * CREATION must therefore read raw: a false-negative there mints a DUPLICATE
 * active reservation for the line, and the native fulfillment workflow
 * subtracts the fulfilled quantity from EVERY reservation of the line —
 * duplicates double-decrement stock.
 *
 * Works with the shared knex connection (`__pg_connection__`, `?` bindings) —
 * no new pg.Pool (Railway connection limits).
 */

export interface ActiveReservationRow {
  id: string;
  quantity: number;
  location_id: string;
  inventory_item_id: string;
}

export async function listActiveReservationsRaw(
  knex: any,
  lineItemId: string
): Promise<ActiveReservationRow[]> {
  const r = await knex.raw(
    `SELECT id, quantity, location_id, inventory_item_id
       FROM reservation_item
      WHERE line_item_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [lineItemId]
  );
  return (r.rows ?? []).map((row: any) => ({
    id: row.id,
    quantity: Number(row.quantity),
    location_id: row.location_id,
    inventory_item_id: row.inventory_item_id,
  }));
}
