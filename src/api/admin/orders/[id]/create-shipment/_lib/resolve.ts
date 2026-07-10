/**
 * Shared resolvers for the create-shipment command + shipment-rates quote.
 * Raw SQL (not query.graph) on purpose: query.graph can drop `fulfillments`
 * for POS orders (known race), and order_item metrics must be filtered to the
 * CURRENT order version (durable rule 2026-06-03).
 */

import type { Pool } from "pg";

import type { DispatchAddress } from "../../../../../../lib/shipping-dispatch/types";
import { DispatchError } from "../../../../../../lib/shipping-dispatch/types";

interface OrderShipToRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
}

/** Ship-to from the order's shipping address (fallback: billing address). */
export async function loadOrderShipTo(
  pool: Pool,
  orderId: string
): Promise<DispatchAddress> {
  const { rows } = await pool.query<OrderShipToRow>(
    `SELECT o.email,
            oa.first_name, oa.last_name, oa.company,
            oa.address_1, oa.address_2, oa.city, oa.province,
            oa.postal_code, oa.country_code, oa.phone
       FROM "order" o
       LEFT JOIN order_address oa
         ON oa.id = COALESCE(o.shipping_address_id, o.billing_address_id)
      WHERE o.id = $1`,
    [orderId]
  );
  const r = rows[0];
  if (!r) {
    throw new DispatchError("invalid_address", "Order not found");
  }
  const name =
    [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
    r.company ||
    "Customer";
  if (!r.address_1 || !r.city || !r.postal_code) {
    throw new DispatchError(
      "invalid_address",
      "Order has no complete shipping address (street/city/zip required)"
    );
  }
  return {
    name,
    company: r.company ?? undefined,
    street1: r.address_1,
    street2: r.address_2 ?? undefined,
    city: r.city,
    state: r.province ?? "",
    zip: r.postal_code,
    country: (r.country_code ?? "us").toUpperCase(),
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
  };
}

export interface ShipItem {
  id: string; // order line item id (ordli_)
  quantity: number;
}

export interface PendingFulfillment {
  id: string;
  items: ShipItem[];
}

/** Line items of a fulfillment (shipped or not — used for resume too). */
export async function loadFulfillmentItems(
  pool: Pool,
  fulfillmentId: string
): Promise<ShipItem[]> {
  const items = await pool.query<{ line_item_id: string | null; quantity: string }>(
    `SELECT line_item_id, quantity
       FROM fulfillment_item
      WHERE fulfillment_id = $1 AND deleted_at IS NULL`,
    [fulfillmentId]
  );
  return items.rows
    .filter((i) => i.line_item_id)
    .map((i) => ({ id: i.line_item_id as string, quantity: Number(i.quantity) }));
}

/** True when the fulfillment already has shipped_at (resume skips the ship step). */
export async function isFulfillmentShipped(
  pool: Pool,
  fulfillmentId: string
): Promise<boolean> {
  const { rows } = await pool.query<{ shipped_at: string | null }>(
    `SELECT shipped_at FROM fulfillment WHERE id = $1`,
    [fulfillmentId]
  );
  return Boolean(rows[0]?.shipped_at);
}

/** Most recent live fulfillment that has not shipped yet (reuse before creating). */
export async function findPendingFulfillment(
  pool: Pool,
  orderId: string
): Promise<PendingFulfillment | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT f.id
       FROM order_fulfillment ofl
       JOIN fulfillment f ON f.id = ofl.fulfillment_id
      WHERE ofl.order_id = $1
        AND f.canceled_at IS NULL
        AND f.shipped_at IS NULL
        AND f.deleted_at IS NULL
      ORDER BY f.created_at DESC
      LIMIT 1`,
    [orderId]
  );
  const fid = rows[0]?.id;
  if (!fid) return null;
  return { id: fid, items: await loadFulfillmentItems(pool, fid) };
}

/** Unfulfilled quantities of the CURRENT order version (version-filter rule). */
export async function loadUnfulfilledItems(
  pool: Pool,
  orderId: string
): Promise<ShipItem[]> {
  const { rows } = await pool.query<{ id: string; qty: string }>(
    `SELECT oi.item_id AS id,
            (oi.quantity - COALESCE(oi.fulfilled_quantity, 0)) AS qty
       FROM order_item oi
       JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND (oi.quantity - COALESCE(oi.fulfilled_quantity, 0)) > 0`,
    [orderId]
  );
  return rows.map((r) => ({ id: r.id, quantity: Number(r.qty) }));
}
