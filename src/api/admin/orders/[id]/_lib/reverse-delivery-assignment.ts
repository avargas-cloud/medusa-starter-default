/**
 * Delivery v2 — reverse an ASSIGNED delivery back to the order's pool.
 *
 * Shared by invoice void (supervisor confirmed "products did NOT leave") and
 * the standalone un-assign command. The physical reversal is exact-line: v2
 * assignments know precisely which order lines (`ordli_`) each delivery
 * fulfilled, so nothing is matched by variant/SKU guessing (the legacy void
 * path's flaw with same-SKU duplicates).
 *
 * Per delivery:
 *   1. Resolve covered units (entire_invoice → invoice lines with line ids;
 *      items → order_delivery_line rows).
 *   2. Revert order_item fulfilled/shipped counters (numeric AND raw_* —
 *      Medusa reads the BigNumber JSONB; see medusa-core rules).
 *   3. Return stock to the fulfillment's location + recreate the reservation
 *      (guarded: never double-reserve a line that still has an active one).
 *   4. Soft-delete the fulfillment tree (labels/items/link/fulfillment).
 *   5. Unlink the delivery → label back to the pool (invoice_id NULL,
 *      scope/assignment stamps cleared, shipped_at NULL, status reset to
 *      label_created) and soft-delete its order_delivery_line rows.
 *
 * The bought label itself is untouched — postage is already paid and the
 * shipment will still happen under the corrected invoice (owner decision
 * 2026-08-07: freed labels return to the pool, they are not carrier-voided).
 */

import type { MedusaRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import type { Pool } from "pg";

export interface AssignedDeliveryRow {
  id: string;
  order_id: string;
  invoice_id: string | null;
  fulfillment_id: string | null;
  invoice_scope: string | null;
  status: string;
}

export interface CoveredUnit {
  order_line_item_id: string;
  quantity: number;
}

/** Live (non-voided) deliveries assigned to an invoice. */
export async function listAssignedDeliveries(
  pool: Pool,
  invoiceId: string
): Promise<AssignedDeliveryRow[]> {
  const { rows } = await pool.query<AssignedDeliveryRow>(
    `SELECT id, order_id, invoice_id, fulfillment_id, invoice_scope, status
       FROM order_delivery
      WHERE invoice_id = $1 AND voided_at IS NULL AND deleted_at IS NULL
        AND status <> 'canceled'`,
    [invoiceId]
  );
  return rows;
}

/** Units a delivery covers, resolved by its scope. */
export async function resolveCoveredUnits(
  pool: Pool,
  delivery: AssignedDeliveryRow
): Promise<CoveredUnit[]> {
  if (delivery.invoice_scope === "items") {
    const { rows } = await pool.query<CoveredUnit>(
      `SELECT order_line_item_id, quantity::int AS quantity
         FROM order_delivery_line
        WHERE delivery_id = $1 AND deleted_at IS NULL`,
      [delivery.id]
    );
    return rows;
  }
  // entire_invoice (or legacy NULL scope on an assigned row): every
  // merchandise line of the invoice that carries its line identity.
  if (!delivery.invoice_id) return [];
  const { rows } = await pool.query<CoveredUnit>(
    `SELECT order_line_item_id, SUM(quantity)::int AS quantity
       FROM pos_invoice_item
      WHERE invoice_id = $1 AND deleted_at IS NULL
        AND order_line_item_id IS NOT NULL
      GROUP BY order_line_item_id`,
    [delivery.invoice_id]
  );
  return rows;
}

type RequestScope = MedusaRequest["scope"];

/**
 * Reverse ONE assigned delivery (steps 1-5 above). Caller holds the
 * `create-shipment:{orderId}` advisory lock.
 */
export async function reverseAssignedDelivery(
  pool: Pool,
  scope: RequestScope,
  delivery: AssignedDeliveryRow,
  auditNote: string
): Promise<void> {
  const units = await resolveCoveredUnits(pool, delivery);

  if (delivery.fulfillment_id) {
    const fulRes = await pool.query<{
      location_id: string | null;
      shipped_at: Date | null;
    }>(
      `SELECT location_id, shipped_at FROM fulfillment WHERE id = $1 LIMIT 1`,
      [delivery.fulfillment_id]
    );
    const locationId = fulRes.rows[0]?.location_id ?? null;
    const wasShipped = Boolean(fulRes.rows[0]?.shipped_at);

    for (const unit of units) {
      const qty = Number(unit.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      // fulfilled_quantity always; shipped_quantity only if the fulfillment
      // shipped (assignment ships immediately, but stay guarded — a reversal
      // must never under-count an unshipped fulfillment).
      await pool.query(
        `UPDATE order_item
            SET fulfilled_quantity = GREATEST(0, fulfilled_quantity - $1::numeric),
                raw_fulfilled_quantity = jsonb_set(
                  raw_fulfilled_quantity, '{value}',
                  to_jsonb(GREATEST(0, (raw_fulfilled_quantity->>'value')::numeric - $1::numeric)::text),
                  false
                )
          WHERE item_id = $2`,
        [qty, unit.order_line_item_id]
      );
      if (wasShipped) {
        await pool.query(
          `UPDATE order_item
              SET shipped_quantity = GREATEST(0, shipped_quantity - $1::numeric),
                  raw_shipped_quantity = jsonb_set(
                    raw_shipped_quantity, '{value}',
                    to_jsonb(GREATEST(0, (raw_shipped_quantity->>'value')::numeric - $1::numeric)::text),
                    false
                  )
            WHERE item_id = $2`,
          [qty, unit.order_line_item_id]
        );
      }

      if (locationId) {
        const invItemRes = await pool.query<{ inventory_item_id: string }>(
          `SELECT pvii.inventory_item_id
             FROM product_variant_inventory_item pvii
             JOIN order_line_item oli ON oli.variant_id = pvii.variant_id
            WHERE oli.id = $1 AND pvii.deleted_at IS NULL
            LIMIT 1`,
          [unit.order_line_item_id]
        );
        const inventoryItemId = invItemRes.rows[0]?.inventory_item_id;
        if (inventoryItemId) {
          const inventoryModule = scope.resolve(Modules.INVENTORY) as {
            adjustInventory: (
              itemId: string,
              locationId: string,
              adjustment: number
            ) => Promise<unknown>;
          };
          await inventoryModule.adjustInventory(
            inventoryItemId,
            locationId,
            qty
          );

          // Recreate the hold — guarded like the legacy void path: an active
          // reservation on the line means the apartado never left, skip.
          const existing = await pool.query(
            `SELECT 1 FROM reservation_item
              WHERE line_item_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [unit.order_line_item_id]
          );
          if (existing.rowCount === 0) {
            try {
              const { createReservationsWorkflow } = await import(
                "@medusajs/core-flows"
              );
              await createReservationsWorkflow(scope).run({
                input: {
                  reservations: [
                    {
                      inventory_item_id: inventoryItemId,
                      location_id: locationId,
                      quantity: qty,
                      line_item_id: unit.order_line_item_id,
                      allow_backorder: true,
                      description: auditNote,
                    },
                  ],
                },
              });
            } catch (resErr) {
              console.warn(
                `[reverse-delivery] reservation recreation failed for ${unit.order_line_item_id}:`,
                resErr instanceof Error ? resErr.message : resErr
              );
            }
          }
        }
      }
    }

    // Soft-delete the fulfillment tree (same statements as the hardened void).
    await pool.query(
      `UPDATE fulfillment_label SET deleted_at = NOW() WHERE fulfillment_id = $1`,
      [delivery.fulfillment_id]
    );
    await pool.query(
      `UPDATE fulfillment_item SET deleted_at = NOW() WHERE fulfillment_id = $1`,
      [delivery.fulfillment_id]
    );
    await pool.query(
      `UPDATE order_fulfillment SET deleted_at = NOW() WHERE fulfillment_id = $1`,
      [delivery.fulfillment_id]
    );
    await pool.query(
      `UPDATE fulfillment SET deleted_at = NOW(), canceled_at = NOW() WHERE id = $1`,
      [delivery.fulfillment_id]
    );
  }

  // Label back to the pool.
  await pool.query(
    `UPDATE order_delivery
        SET invoice_id = NULL, invoice_scope = NULL,
            assigned_at = NULL, assigned_by_user_id = NULL,
            fulfillment_id = NULL, shipped_at = NULL,
            status = 'label_created', status_detail = $2, updated_at = now()
      WHERE id = $1`,
    [delivery.id, auditNote.slice(0, 500)]
  );
  await pool.query(
    `UPDATE order_delivery_line SET deleted_at = NOW()
      WHERE delivery_id = $1 AND deleted_at IS NULL`,
    [delivery.id]
  );
}
