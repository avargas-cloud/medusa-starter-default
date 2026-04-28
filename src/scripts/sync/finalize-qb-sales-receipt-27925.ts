/**
 * Phase 3 — finalize the SR-27925 backfill so the POS UI shows it correctly.
 *
 * Run after backfill-qb-sales-receipt-27925.ts:
 *   yarn medusa exec ./src/scripts/sync/finalize-qb-sales-receipt-27925.ts
 *
 * What this fixes:
 *   1. customer_payment.qb = { source: 'sales_receipt', status: 'yes' } — SR badge
 *      on the Payments page (line 331 of payments/page.tsx).
 *   2. order.metadata.qb_invoice + qb_invoice_ref_num — flips the QB-sync column
 *      from "Missing in QB" → the QB ref number on the Orders list.
 *   3. Captures the Medusa native payment so order.payment_status='captured'.
 *   4. Creates the fulfillment via createOrderFulfillmentWorkflow + marks delivered
 *      so order.fulfillment_status='delivered'.
 *   5. Stamps pos_invoice.fulfillment_id with the new fulfillment.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { registerMedusaPayment } from "../../api/admin/invoices/register-medusa-payment";

const ORDER_ID = "order_01KQA504YWN2WRR0WE6WX38G20";
const POS_INVOICE_ID = "01KQA5VG5B1C9489YWDGQVW91A";
const PAYMENT_ID = "cpay_01KQA5VGN5P23XWJTGAK4NV1M6";
const QB_TXN_ID = "1C1A27-1777061321";
const QB_REF_NUMBER = "27925";
const QB_EDIT_SEQUENCE = "1777061321";
const TOTAL_CENTS = 23273;
const LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR"; // Ecopowertech Miami

export default async function finalizeQbSr27925({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve(Modules.ORDER);
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;
  const pg = container.resolve("__pg_connection__") as any;

  // ── 1. SR badge on payment ─────────────────────────────────────────────────
  await pg.raw(
    `UPDATE customer_payment
        SET qb = jsonb_build_object('source','sales_receipt','status','yes','txn_id',?::text,'ref_number',?::text),
            metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('qb_sync_status','synced','qb_source','sales_receipt')
      WHERE id = ?`,
    [QB_TXN_ID, QB_REF_NUMBER, PAYMENT_ID]
  );
  logger.info(`✅ customer_payment.qb populated → SR badge will render`);

  // ── 2. Order metadata for the QB-sync column on the Orders list ────────────
  const order = (await orderModule.retrieveOrder(ORDER_ID, {
    select: ["id", "metadata"],
  })) as any;
  await orderModule.updateOrders(ORDER_ID, {
    metadata: {
      ...(order.metadata ?? {}),
      qb_invoice: {
        txn_id: QB_TXN_ID,
        ref_number: QB_REF_NUMBER,
        edit_sequence: QB_EDIT_SEQUENCE,
        type: "SalesReceipt",
      },
      qb_invoice_ref_num: QB_REF_NUMBER,
      qb_invoice_txn_id: QB_TXN_ID,
    },
  });
  logger.info(`✅ order.metadata.qb_invoice populated → QB ref column shows ${QB_REF_NUMBER}`);

  // ── 3. Capture Medusa native payment ───────────────────────────────────────
  const medusaPayId = await registerMedusaPayment(container, {
    order_id: ORDER_ID,
    amount: TOTAL_CENTS,
    payment_method: "debit_card",
    invoice_total: TOTAL_CENTS,
  });
  if (medusaPayId) {
    logger.info(`✅ Medusa payment captured: ${medusaPayId} (order is now Paid)`);
  } else {
    logger.warn(`⚠️  registerMedusaPayment returned null — check logs`);
  }

  // ── 4. Create fulfillment + mark delivered ────────────────────────────────
  const orderItems = (
    await pg.raw(
      `SELECT oi.item_id, oi.quantity, oi.fulfilled_quantity, oli.variant_id
         FROM order_item oi
         JOIN order_line_item oli ON oli.id = oi.item_id
        WHERE oi.order_id = ?`,
      [ORDER_ID]
    )
  ).rows as Array<{
    item_id: string;
    quantity: string;
    fulfilled_quantity: string;
    variant_id: string;
  }>;

  const fulfillmentItems = orderItems
    .map((oi) => ({
      id: oi.item_id,
      quantity: Math.max(0, Number(oi.quantity) - Number(oi.fulfilled_quantity)),
      variant_id: oi.variant_id,
    }))
    .filter((i) => i.quantity > 0);

  if (!fulfillmentItems.length) {
    logger.warn(`⚠️  No unfulfilled items — skipping fulfillment creation`);
  } else {
    // Unblock requires_shipping so the workflow doesn't trip on shipping profile
    await pg.raw(
      `UPDATE order_line_item SET requires_shipping = false WHERE id = ANY(?::text[])`,
      [fulfillmentItems.map((i) => i.id)]
    );

    // Ensure stock reservations exist
    const { createReservationsWorkflow } = await import("@medusajs/core-flows");
    for (const fi of fulfillmentItems) {
      try {
        const existing = await inventoryModule.listReservationItems(
          { line_item_id: fi.id },
          { take: 1 }
        );
        if (existing?.length) continue;
        const inv = await pg.raw(
          `SELECT inventory_item_id FROM product_variant_inventory_item
            WHERE variant_id = ? AND deleted_at IS NULL LIMIT 1`,
          [fi.variant_id]
        );
        const invItemId = inv.rows[0]?.inventory_item_id;
        if (!invItemId) continue;
        await createReservationsWorkflow(container).run({
          input: {
            reservations: [
              {
                inventory_item_id: invItemId,
                location_id: LOCATION_ID,
                quantity: fi.quantity,
                line_item_id: fi.id,
              },
            ],
          },
        });
      } catch (e: any) {
        logger.warn(
          `   reservation warning for ${fi.id}: ${e.message?.slice(0, 100)}`
        );
      }
    }

    const {
      createOrderFulfillmentWorkflow,
      markOrderFulfillmentAsDeliveredWorkflow,
    } = await import("@medusajs/core-flows");

    const fulfillRes = await createOrderFulfillmentWorkflow(container).run({
      input: {
        order_id: ORDER_ID,
        items: fulfillmentItems.map((fi) => ({
          id: fi.id,
          quantity: fi.quantity,
        })),
        location_id: LOCATION_ID,
        no_notification: true,
        created_by: "manual-backfill-sr-27925",
      },
    });
    const fulfillment = fulfillRes.result as any;
    const fulfillmentId = fulfillment?.id;
    if (!fulfillmentId) throw new Error("Fulfillment workflow returned no id");
    logger.info(`✅ Fulfillment created: ${fulfillmentId}`);

    // Patch fulfilled_quantity on order_item junction
    for (const fi of fulfillmentItems) {
      await pg.raw(
        `UPDATE order_item
            SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + ?::numeric)
          WHERE item_id = ? AND order_id = ?`,
        [fi.quantity, fi.id, ORDER_ID]
      );
    }

    await markOrderFulfillmentAsDeliveredWorkflow(container).run({
      input: { orderId: ORDER_ID, fulfillmentId },
    });
    logger.info(`✅ Fulfillment marked as delivered`);

    // Bind to pos_invoice
    await pg.raw(
      `UPDATE pos_invoice SET fulfillment_id = ? WHERE id = ?`,
      [fulfillmentId, POS_INVOICE_ID]
    );
    logger.info(`✅ pos_invoice ${POS_INVOICE_ID} bound to fulfillment ${fulfillmentId}`);
  }

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`✅ FINALIZE DONE — order should now show synced + paid + delivered`);
  logger.info(`${"=".repeat(60)}`);
}
