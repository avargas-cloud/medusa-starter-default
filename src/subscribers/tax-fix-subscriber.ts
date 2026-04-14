/**
 * tax-fix-subscriber.ts
 *
 * Removes duplicate tax lines created by Medusa's native updateOrderTaxLinesWorkflow.
 *
 * BACKGROUND:
 *   Medusa's `order_line_item_tax_line` table stores only the TAX RATE (e.g., 7%).
 *   The dollar amounts shown in admin are computed dynamically as:
 *       amount = rate × item.unit_price × item.quantity
 *   This means Medusa always applies tax to the GROSS price, never to the
 *   discount-adjusted price. Our POS (computeTotals) and payment collection
 *   (metadata.computed_total) correctly use the discount-aware amount.
 *   The native Medusa admin shows the gross-based tax — that is a Medusa
 *   architectural limitation, not something we patch here.
 *
 * WHAT THIS SUBSCRIBER DOES:
 *   When an order is placed or an order edit is confirmed, Medusa may create
 *   duplicate tax lines (one 'FL' from our provider + one 'manual' from the
 *   native engine). This subscriber fires after those events and deletes any
 *   tax lines whose code is not one of our known codes (FL, FL-SHIPPING, EXEMPT).
 *
 *   After deletion, the order will show a single 'FL 7%' line in the native admin
 *   which is the correct rate. The POS and payment collection always use the
 *   discount-aware amount from metadata.computed_total which is accurate.
 *
 * COVERS:
 *   3. Convert Draft → Order  →  fires `order.placed`
 *   4. Save New Order         →  fires `order.placed`
 *   5. Edit Order confirmed   →  fires `order-edit.confirmed`
 *
 * Always soft-fails — never blocks the order flow.
 */

import type { SubscriberConfig, SubscriberArgs } from "@medusajs/framework";
import { Pool } from "pg";

const LOG = "[tax-fix]";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return _pool;
}

type OrderPlacedData = { id: string };
type OrderEditConfData = { order_id: string };

export default async function taxFixSubscriber({
  event: { name, data },
}: SubscriberArgs<OrderPlacedData | OrderEditConfData>) {
  try {
    // Resolve order ID: order.placed → data.id, order-edit.confirmed → data.order_id
    const orderId: string =
      (data as OrderEditConfData).order_id ?? (data as OrderPlacedData).id;

    if (!orderId?.startsWith("order_")) {
      console.warn(`${LOG} Skipping — unexpected id: ${orderId}`);
      return;
    }

    console.log(`${LOG} [${name}] Removing duplicate tax lines for ${orderId}`);

    const db = getPool();
    const client = await db.connect();
    try {
      // Delete any non-POS-generated tax lines:
      //   'manual' lines come from Medusa's native engine (tp_system provider)
      //   if any stale sub-region rate exists. Deleting these
      //   removes the double-counting without touching the POS-generated FL lines.
      const del = await client.query(
        `DELETE FROM order_line_item_tax_line
                 WHERE item_id IN (
                     SELECT item_id FROM order_item WHERE order_id = $1
                 )
                 AND code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`,
        [orderId]
      );

      if ((del.rowCount ?? 0) > 0) {
        console.log(
          `${LOG} ✅ Removed ${del.rowCount} duplicate tax lines for ${orderId}`
        );
      } else {
        console.log(
          `${LOG} No duplicate lines found for ${orderId} — nothing to do`
        );
      }

      // Note: order_line_item_tax_line stores only `rate`, not `amount`.
      // Medusa computes the displayed dollar amount as rate × unit_price × qty.
      // The discount-aware correct amount is stored in order.metadata.computed_tax_amount
      // and used by the POS UI (computeTotals) and payment collection (convertTrueTotal).
      // The native Medusa admin will show the gross-based amount — this is a known
      // Medusa limitation that requires core patching to resolve fully.
    } finally {
      client.release();
    }
  } catch (err: any) {
    // Always soft-fail — never block the order confirmation
    console.warn(`${LOG} ⚠️ Tax fix soft-failed: ${err?.message}`);
  }
}

export const config: SubscriberConfig = {
  event: [
    "order.placed", // Cases 3 (convert draft→order) + 4 (new order)
    "order-edit.confirmed", // Case 5 (order edit confirmed)
  ],
};
