/**
 * src/lib/inventory/reservations-by-sku.ts
 *
 * Who is holding the RESERVED units of one SKU in Miami — the decomposition of
 * the `RESERVED` figure in the POS stock modal, order by order.
 *
 * WHY THIS IS NOT `separations_elsewhere`
 * The Separation modal already lists "who has this SKU SET ASIDE" (rows of
 * `order_line_separation`, physically apart on the shelf). This is a different
 * question with the same table shape: a reservation is the promise an order
 * makes on stock the moment it is placed; a separation is the warehouse acting
 * on that promise. Every separated unit is reserved, not every reserved unit is
 * separated. The two lists are kept apart on purpose (owner decision
 * 2026-09-14): the stock modal shows reservations only, the separation modal
 * shows separations only.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 *
 *     reserved == Σ(rows[].reserved) + unattributed
 *
 * `reserved` is the `inventory_level.reserved_quantity` cache — the SAME number
 * the badge and the modal already print, read from the same column, so the
 * headline cannot contradict the rows because of a second definition. The rows
 * come from `reservation_item` joined to the live order version. A reservation
 * that cannot be tied to a live order (no line item, a deleted line, an order
 * version the item no longer belongs to) is not dropped and not clamped: it is
 * reported as `unattributed`, so the arithmetic closes visibly and a stale
 * reservation shows up as a number instead of as silence.
 *
 * SCOPE IS MIAMI (USA_LOC) ONLY — house rule, same as the separation caps. China
 * reservations are inventory transfers, not customers, and the modal already
 * shows them as IN TRANSIT.
 */

import { USA_LOC } from "../locations";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface ReservationBySkuRow {
  order_id: string;
  display_id: number | null;
  customer_name: string;
  sku: string;
  ordered: number;
  reserved: number;
}

export interface ReservationsBySku {
  sku: string;
  location_id: string;
  /** `inventory_level.reserved_quantity` summed over the SKU's items. */
  reserved: number;
  rows: ReservationBySkuRow[];
  /** `reserved − Σ rows` — reservations no live order line accounts for. */
  unattributed: number;
}

/** Postgres numerics arrive as strings over the wire. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function resolveReservationsBySku(
  knex: Knex,
  sku: string,
  locationId: string = USA_LOC
): Promise<ReservationsBySku> {
  // Headline: the cache the badge prints. One SKU can map to more than one
  // inventory item (it has happened); sum them rather than pick one.
  const level = await knex.raw(
    `SELECT COALESCE(SUM(il.reserved_quantity), 0) AS reserved
       FROM inventory_item ii
       JOIN inventory_level il
         ON il.inventory_item_id = ii.id
        AND il.location_id = ?
        AND il.deleted_at IS NULL
      WHERE ii.sku = ?
        AND ii.deleted_at IS NULL`,
    [locationId, sku]
  );
  const reserved = num((level.rows[0] as { reserved?: unknown })?.reserved);

  // Rows: one per (order, line), on the order's CURRENT version — `order_item`
  // keeps a row per version and the stale ones would multiply the quantities.
  const res = await knex.raw(
    `SELECT o.id                          AS order_id,
            o.display_id                  AS display_id,
            COALESCE(
              NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
              NULLIF(c.company_name, ''),
              c.email
            )                             AS customer_name,
            oli.variant_sku               AS sku,
            oi.quantity                   AS ordered,
            SUM(r.quantity)               AS reserved
       FROM reservation_item r
       JOIN inventory_item ii
         ON ii.id = r.inventory_item_id
        AND ii.deleted_at IS NULL
       JOIN order_line_item oli
         ON oli.id = r.line_item_id
        AND oli.deleted_at IS NULL
       JOIN order_item oi
         ON oi.item_id = oli.id
        AND oi.deleted_at IS NULL
       JOIN "order" o
         ON o.id = oi.order_id
        AND o.version = oi.version
        AND o.deleted_at IS NULL
       LEFT JOIN customer c
         ON c.id = o.customer_id
        AND c.deleted_at IS NULL
      WHERE ii.sku = ?
        AND r.location_id = ?
        AND r.deleted_at IS NULL
      GROUP BY o.id, o.display_id, customer_name, oli.id, oli.variant_sku, oi.quantity
      ORDER BY o.display_id ASC, oli.id ASC`,
    [sku, locationId]
  );

  const rows: ReservationBySkuRow[] = [];
  for (const raw of res.rows as Array<Record<string, unknown>>) {
    const qty = num(raw.reserved);
    if (qty <= 0) continue;
    rows.push({
      order_id: String(raw.order_id),
      display_id: raw.display_id == null ? null : num(raw.display_id),
      customer_name:
        typeof raw.customer_name === "string" && raw.customer_name
          ? raw.customer_name
          : "—",
      sku: String(raw.sku ?? "").trim(),
      ordered: num(raw.ordered),
      reserved: qty,
    });
  }

  const attributed = rows.reduce((acc, r) => acc + r.reserved, 0);

  return {
    sku,
    location_id: locationId,
    reserved,
    rows,
    unattributed: reserved - attributed,
  };
}
