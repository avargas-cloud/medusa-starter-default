/**
 * Zero the separation of every line of an order that has fully left the
 * warehouse.
 *
 * A separation is a claim on physical stock: `separable_cap` subtracts what
 * OTHER orders keep separated, so a stale row keeps units reserved for an order
 * that already took them home. The readers all net it (`GREATEST(0, sep.qty -
 * fulfilled)` in the cross-order query, and `separation-data` nets what it
 * returns), so nothing is double-counted today — but the row itself stays
 * wrong, and every future reader has to remember to net it. This makes the
 * stored value tell the truth instead.
 *
 * SET TO ZERO, never subtract a delta. `qty = qty - n` run twice — a retry, a
 * re-dispatch, a job that fires again — eats units that were never delivered,
 * and nothing downstream could tell the difference. `qty = 0` is the same
 * whether it runs once or five times, which is the property that matters on a
 * path that can be retried.
 *
 * Only FULLY fulfilled lines are cleared. A partially delivered line still
 * holds real units on the shelf; its display and its pool contribution are
 * netted by the readers, and guessing which of its units left would be
 * inventing a number.
 *
 * `fulfilled` is read from LIVE fulfillments, never from
 * `order_item.fulfilled_quantity` — that aggregate is written forward and never
 * reverted, so a canceled-and-deleted fulfillment would have this function
 * clearing separations for goods still sitting on the shelf.
 *
 * Best-effort by contract: the caller has already dispatched or handed over the
 * goods, and failing to tidy a mark must never undo that.
 */

import type { Pool } from "pg";

import { loadSeparationData } from "../../api/admin/orders/[id]/_lib/separation-data";
import { separationStatusLinesOf } from "../../api/admin/orders/_lib/separation-caps";
import { deriveSeparationStatus } from "../../api/admin/orders/_lib/separation-status";

/** Returns the order_line_item ids whose separation this call zeroed. */
export async function clearDeliveredSeparations(
  pool: Pool,
  orderId: string
): Promise<string[]> {
  if (!orderId) return [];
  try {
    const res = await pool.query<{ order_line_item_id: string }>(
      `WITH fulfilled AS (
         SELECT oli.id                                   AS line_id,
                oi.quantity                              AS ordered,
                COALESCE(SUM(ffi.quantity), 0)           AS out_the_door
           FROM order_item oi
           JOIN "order" o
             ON o.id = oi.order_id
            AND oi.version = o.version
           JOIN order_line_item oli
             ON oli.id = oi.item_id
            AND oli.deleted_at IS NULL
           LEFT JOIN order_fulfillment ofl
             ON ofl.order_id = oi.order_id
            AND ofl.deleted_at IS NULL
           LEFT JOIN fulfillment f
             ON f.id = ofl.fulfillment_id
            AND f.canceled_at IS NULL
            AND f.deleted_at IS NULL
           LEFT JOIN fulfillment_item ffi
             ON ffi.fulfillment_id = f.id
            AND ffi.deleted_at IS NULL
            AND ffi.line_item_id = oli.id
          WHERE oi.order_id = $1
            AND oi.deleted_at IS NULL
          GROUP BY oli.id, oi.quantity
       )
       UPDATE order_line_separation sep
          SET qty = 0, updated_at = now()
         FROM fulfilled
        WHERE sep.order_id = $1
          AND sep.order_line_item_id = fulfilled.line_id
          AND fulfilled.out_the_door >= fulfilled.ordered
          AND sep.qty > 0
       RETURNING sep.order_line_item_id`,
      [orderId]
    );

    // Y RE-DERIVAR EL ESTADO. Sacar unidades del deposito cambia el pendiente,
    // asi que el `separation_status` guardado deja de ser cierto — pero nadie lo
    // recalcula: se escribe solo cuando alguien guarda el modal. S11320 quedo
    // con el badge `Separated` (full) mientras la derivacion viva decia partial
    // (8 pendientes, 7 apartadas), al lado de un `To Separate 1` correcto. Los
    // dos slots de esa columna son estado + trabajo, y pueden convivir; lo que
    // no puede es que el estado sea de antes de la entrega.
    //
    // El UPDATE sobre "order" dispara el trigger de Meili, que es como el badge
    // llega a la lista. Merge con `||` — nunca reemplazo: `store.metadata` y
    // `order.metadata` pierden claves si se escriben enteros.
    const data = await loadSeparationData(pool, orderId);
    if (data) {
      const status = deriveSeparationStatus(
        // Mismo filtro que la ruta de escritura, por el mismo helper: si cada
        // una eligiera sus líneas por su cuenta, guardar el modal y despachar
        // dejarían estados distintos sobre los mismos datos.
        separationStatusLinesOf(data.lines).map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: l.separated,
        })),
        // legacy = false A PROPOSITO. Ese flag existe para ordenes anteriores al
        // tracking por linea, donde `is_separated=true` sin filas se honra como
        // `full`. Aca acabamos de escribir filas, asi que la orden TIENE
        // tracking por linea — y si todas quedaron en 0 la respuesta honesta es
        // `none`, no heredar el `full` de antes de la entrega, que es
        // exactamente el valor viejo que vinimos a corregir.
        false
      );
      await pool.query(
        `UPDATE "order"
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          orderId,
          JSON.stringify({
            separation_status: status,
            is_separated: status === "full",
          }),
        ]
      );
    }

    return res.rows.map((r) => r.order_line_item_id);
  } catch (err) {
    console.warn(
      `[clear-delivered-separations] non-fatal for ${orderId}: ${
        (err as Error)?.message
      }`
    );
    return [];
  }
}
