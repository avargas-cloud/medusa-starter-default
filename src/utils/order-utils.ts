import { Modules } from "@medusajs/utils";
import { getDbPool } from "../api/utils/db-pool";

/**
 * Dynamically computes and resets the true native Medusa Order statuses
 * based purely on factual order_item quantities and pos_invoice records.
 * Use this after voiding invoices, changing fulfillments, or manual payment interventions.
 * @param orderId - The Medusa Order ID (e.g. order_01...)
 * @param container - Provide the Medusa dependency scope to invoke native services
 */
export async function recalculateOrderStatus(
  orderId: string,
  container?: any
): Promise<void> {
  const pool = getDbPool();

  try {
    // Step 1: Calculate the true Fulfillment Status based on order_item metrics
    const itemRes = await pool.query(
      `SELECT 
                SUM(quantity) as total_qty, 
                SUM(fulfilled_quantity) as total_fulfilled, 
                SUM(delivered_quantity) as total_delivered,
                SUM(shipped_quantity) as total_shipped
             FROM order_item 
             WHERE order_id = $1`,
      [orderId]
    );
    const metrics = itemRes.rows[0];
    const qty = Number(metrics?.total_qty || 0);
    const fulfilled = Number(metrics?.total_fulfilled || 0);
    const delivered = Number(metrics?.total_delivered || 0);

    let newFulfillmentStatus = "not_fulfilled";

    if (fulfilled > 0 && fulfilled < qty) {
      newFulfillmentStatus = "partially_fulfilled";
    } else if (fulfilled > 0 && fulfilled >= qty) {
      newFulfillmentStatus = "fulfilled";
      // Note: If delivered == qty we could set shipped, but 'fulfilled' is standard for POS.
    }

    // Step 2: Recognized payment from non-voided POS invoices. pos_invoice is the
    // POS source of truth for money. This is only needed to decide whether to
    // zero out the native payment collections below — NOT to derive a status.
    //
    // ⚠️ We deliberately do NOT read `order.total` here. In Medusa v2 the "order"
    // table has no physical `total` column (it's a derived/summary value), so
    // `SELECT total FROM "order"` throws `column "total" does not exist`, which
    // aborted this whole recalc before it could reset the status — that's why a
    // voided-invoice order stayed `completed` and dropped out of the Open tab.
    const invoiceRes = await pool.query(
      `SELECT SUM(amount_paid) as total_paid
             FROM pos_invoice
             WHERE order_id = $1 AND status != 'voided'`,
      [orderId]
    );
    const totalPaid = Number(invoiceRes.rows[0]?.total_paid || 0);

    // This helper only runs to REOPEN an order after a void / fulfillment change,
    // so the target is always the open state 'pending'. Native completion is a
    // separate flow (completeOrderWorkflow / maybeCompleteOrder, which re-checks
    // its own guards) — we never re-close an order here.
    const newStatus = "pending";

    // Step 3: Native Medusa reversal of generic payment collections if sum hits 0
    if (totalPaid === 0 && container) {
      try {
        // We resolve the native module to properly zero out rather than raw SQL (Hardcode avoidance)
        const paymentModule = container.resolve("paymentModuleService");
        const collections = await paymentModule.listPaymentCollections({
          order_id: orderId,
        });

        for (const pc of collections) {
          await pool.query(
            `UPDATE payment_collection SET captured_amount = 0 WHERE id = $1`,
            [pc.id]
          );
          await pool.query(
            `UPDATE payment SET amount = 0, captured_at = NULL, canceled_at = NOW() WHERE payment_collection_id = $1`,
            [pc.id]
          );
        }
        console.log(
          `[ORDER ORACLE] Natively processed zeroing for Medusa payment collections -> ${orderId}`
        );
      } catch (err: any) {
        console.warn(
          `[ORDER ORACLE] Native payment zeroing warning: ${err.message}`
        );
      }
    }

    // Apply
    console.log(
      `[ORDER ORACLE] Recalculating ${orderId} | Fulfillment: ${newFulfillmentStatus} | Paid(cents): ${totalPaid} | Delivered: ${delivered} | Status: ${newStatus}`
    );
    // In Medusa v2 the "order" table only has a physical `status` column.
    // `fulfillment_status` and `payment_status` are DERIVED at query time from
    // the fulfillment / payment_collection rows — they are NOT columns here.
    // The old UPDATE wrote all three, so it failed entirely ("column ... does
    // not exist"), the catch below swallowed it, and `status` never got reset
    // after an invoice void → the order stayed `completed` and dropped out of
    // the Open tab.
    //
    // Reverting completion natively = updateOrders({ status }). Completion is a
    // pure status flag (completeOrder_ only sets status='completed'); Medusa's
    // own completeOrdersStep compensation reverts it the same way. Use the ORDER
    // module when we have the container; fall back to raw SQL otherwise.
    if (container) {
      const orderModule = container.resolve(Modules.ORDER);
      await orderModule.updateOrders([{ id: orderId, status: newStatus }]);
    } else {
      await pool.query(`UPDATE "order" SET status = $1 WHERE id = $2`, [
        newStatus,
        orderId,
      ]);
    }
  } catch (e: any) {
    console.error(
      `[ORDER ORACLE] Failed to recalculate order status for ${orderId}:`,
      e.message
    );
  }
}
