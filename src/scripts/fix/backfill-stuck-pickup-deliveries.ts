/**
 * backfill-stuck-pickup-deliveries.ts
 *
 * Closes the loop on local-pickup invoices whose fulfillment was created
 * but never marked delivered. Caused by a race condition in the prior POS
 * checkout flow that called mark-as-delivered as a separate HTTP request
 * and silenced 404s during Medusa's commit window.
 *
 * What it does for each affected pos_invoice:
 *   1. Verifies fulfillment exists and is alive (not canceled, not delivered)
 *   2. Runs markOrderFulfillmentAsDeliveredWorkflow
 *   3. Stamps order.metadata.picked_up_at (matches the invoice's paid_at)
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/backfill-stuck-pickup-deliveries.ts
 */

import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/core-flows";

export default async function backfillStuckPickupDeliveries({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const orderModule = container.resolve(Modules.ORDER) as any;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as any;

  // Find every live invoice whose fulfillment was never delivered.
  const stuck: Array<{
    invoice_id: string;
    invoice_number: string;
    order_id: string;
    fulfillment_id: string;
    paid_at: Date | null;
  }> = await knex.raw(
    `
    SELECT pi.id AS invoice_id,
           pi.invoice_number,
           pi.order_id,
           pi.fulfillment_id,
           pi.paid_at
      FROM pos_invoice pi
      JOIN fulfillment f ON f.id = pi.fulfillment_id
     WHERE pi.fulfillment_id IS NOT NULL
       AND pi.voided_at IS NULL
       AND pi.deleted_at IS NULL
       AND f.canceled_at IS NULL
       AND f.delivered_at IS NULL
       AND f.shipped_at IS NULL
     ORDER BY pi.created_at
    `
  ).then((r: any) => r.rows ?? r);

  if (!stuck.length) {
    logger.info(`[backfill-stuck-pickup] ✅ No stuck invoices found.`);
    return;
  }

  logger.info(
    `[backfill-stuck-pickup] Found ${stuck.length} stuck invoice(s) — fixing...`
  );

  let fixed = 0;
  let failed = 0;
  for (const row of stuck) {
    try {
      logger.info(
        `[backfill-stuck-pickup] → invoice=${row.invoice_number} order=${row.order_id} fulfillment=${row.fulfillment_id}`
      );

      // 1. Try canonical workflow first.
      // Falls through to direct SQL when the order has prior canceled
      // fulfillments that already pumped delivered_quantity to its cap
      // (workflow refuses double-delivery) or when the fulfillment isn't
      // linked via order_fulfillment.
      let workflowOk = false;
      try {
        await markOrderFulfillmentAsDeliveredWorkflow(container).run({
          input: {
            orderId: row.order_id,
            fulfillmentId: row.fulfillment_id,
          },
        });
        workflowOk = true;
      } catch (workflowErr: any) {
        logger.warn(
          `[backfill-stuck-pickup]   workflow refused (${workflowErr?.message?.slice(0, 80)}) — using direct SQL fallback`
        );
      }

      if (!workflowOk) {
        const stampedAt = row.paid_at ?? new Date();
        await knex.raw(
          `UPDATE fulfillment SET delivered_at = ?, updated_at = NOW() WHERE id = ? AND delivered_at IS NULL`,
          [stampedAt, row.fulfillment_id]
        );
      }

      // 2. Stamp picked_up_at on order metadata (use paid_at if we have it)
      try {
        const order = await orderModule.retrieveOrder(row.order_id);
        const meta = (order?.metadata ?? {}) as Record<string, unknown>;
        if (!meta.picked_up_at) {
          const paidAtDate =
            row.paid_at instanceof Date
              ? row.paid_at
              : row.paid_at
                ? new Date(row.paid_at)
                : new Date();
          await orderModule.updateOrders([
            {
              id: row.order_id,
              metadata: {
                ...meta,
                picked_up_at: paidAtDate.toISOString(),
                picked_up_by: meta.picked_up_by ?? "backfill-script",
              },
            },
          ]);
        }
      } catch (metaErr: any) {
        logger.warn(
          `[backfill-stuck-pickup]   metadata stamp warning: ${metaErr?.message}`
        );
      }

      fixed++;
      logger.info(
        `[backfill-stuck-pickup]   ✅ Marked ${row.fulfillment_id} as delivered`
      );
    } catch (err: any) {
      failed++;
      logger.error(
        `[backfill-stuck-pickup]   ❌ Failed for ${row.invoice_number}: ${err?.message}`
      );
    }
  }

  logger.info(
    `[backfill-stuck-pickup] Done — ${fixed} fixed, ${failed} failed of ${stuck.length} total.`
  );
}
