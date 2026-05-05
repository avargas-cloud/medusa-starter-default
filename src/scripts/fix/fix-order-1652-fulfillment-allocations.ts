/**
 * Repair order 1652 / Carlos Salado after the QB invoice import script left
 * allocations open without creating a Medusa fulfillment.
 *
 * Dry-run:
 *   yarn medusa exec ./src/scripts/fix/fix-order-1652-fulfillment-allocations.ts
 *
 * Apply:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-order-1652-fulfillment-allocations.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const ORDER_ID = "order_01KQMSZSWXFS3C9NDVNF1Q4GZN";
const INVOICE_ID = "01KQN88KTJCC5S9KYNBQWQ07D9";
const LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

interface FulfillmentItem {
  id: string;
  quantity: number;
  variant_id: string | null;
}

export default async function fixOrder1652FulfillmentAllocations({
  container,
}: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const orderModule = container.resolve(Modules.ORDER) as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  logger.info(
    `${apply ? "APPLY" : "DRY-RUN"} repair for order 1652 (${ORDER_ID}), invoice ${INVOICE_ID}`
  );

  const orderRows = (
    await pg.raw(
      `SELECT id, display_id, email, metadata
         FROM "order"
        WHERE id = ?
          AND deleted_at IS NULL
          AND canceled_at IS NULL
        LIMIT 1`,
      [ORDER_ID]
    )
  ).rows;
  if (!orderRows.length) {
    throw new Error(`Order not found or canceled: ${ORDER_ID}`);
  }

  const invoiceRows = (
    await pg.raw(
      `SELECT id, invoice_number, status, fulfillment_id
         FROM pos_invoice
        WHERE id = ?
          AND order_id = ?
          AND deleted_at IS NULL
        LIMIT 1`,
      [INVOICE_ID, ORDER_ID]
    )
  ).rows as Array<{
    id: string;
    invoice_number: string;
    status: string;
    fulfillment_id: string | null;
  }>;
  const invoice = invoiceRows[0];
  if (!invoice) {
    throw new Error(`Invoice ${INVOICE_ID} not found for order ${ORDER_ID}`);
  }
  if (invoice.status === "voided" || invoice.status === "draft") {
    throw new Error(`Invoice ${invoice.invoice_number} is ${invoice.status}`);
  }
  if (invoice.fulfillment_id) {
    logger.info(
      `Invoice already has fulfillment_id=${invoice.fulfillment_id}; nothing to repair.`
    );
    return;
  }

  const itemRows = (
    await pg.raw(
      `SELECT
          oi.item_id,
          oi.quantity,
          COALESCE(oi.fulfilled_quantity, 0) AS fulfilled_quantity,
          oli.variant_id,
          oli.variant_sku,
          COALESCE((
            SELECT SUM(ri.quantity)
            FROM reservation_item ri
            WHERE ri.line_item_id = oi.item_id
              AND ri.deleted_at IS NULL
          ), 0) AS reserved_qty
         FROM order_item oi
         JOIN order_line_item oli ON oli.id = oi.item_id
        WHERE oi.order_id = ?
          AND oi.deleted_at IS NULL
          AND oli.deleted_at IS NULL
          AND oi.quantity > 0
        ORDER BY oli.created_at`,
      [ORDER_ID]
    )
  ).rows as Array<{
    item_id: string;
    quantity: string;
    fulfilled_quantity: string;
    variant_id: string | null;
    variant_sku: string | null;
    reserved_qty: string;
  }>;

  const fulfillmentItems: FulfillmentItem[] = itemRows
    .map((row) => ({
      id: row.item_id,
      quantity: Math.max(0, Number(row.quantity) - Number(row.fulfilled_quantity)),
      variant_id: row.variant_id,
    }))
    .filter((item) => item.quantity > 0);

  if (!fulfillmentItems.length) {
    logger.info("No unfulfilled order items found; nothing to repair.");
    return;
  }

  logger.info("Items to fulfill:");
  for (const row of itemRows) {
    const remaining = Math.max(
      0,
      Number(row.quantity) - Number(row.fulfilled_quantity)
    );
    if (remaining <= 0) continue;
    logger.info(
      `  ${row.variant_sku ?? row.variant_id ?? row.item_id}: fulfill=${remaining}, open_reserved=${row.reserved_qty}`
    );
  }

  const openReservationsBefore = itemRows.reduce(
    (sum, row) => sum + Number(row.reserved_qty),
    0
  );
  logger.info(`Open reserved quantity before repair: ${openReservationsBefore}`);

  if (!apply) {
    logger.info(
      "Dry-run only. Re-run with APPLY=1 to create fulfillment and consume allocations."
    );
    return;
  }

  await pg.raw(`UPDATE order_line_item SET requires_shipping = false WHERE id = ANY(?::text[])`, [
    fulfillmentItems.map((item) => item.id),
  ]);

  const { createReservationsWorkflow } = await import("@medusajs/core-flows");
  for (const item of fulfillmentItems) {
    const existing = await inventoryModule.listReservationItems(
      { line_item_id: item.id },
      { take: 1 }
    );
    if (existing?.length || !item.variant_id) continue;

    const invRows = (
      await pg.raw(
        `SELECT inventory_item_id
           FROM product_variant_inventory_item
          WHERE variant_id = ?
            AND deleted_at IS NULL
          LIMIT 1`,
        [item.variant_id]
      )
    ).rows as Array<{ inventory_item_id: string }>;
    const inventoryItemId = invRows[0]?.inventory_item_id;
    if (!inventoryItemId) continue;

    await createReservationsWorkflow(container).run({
      input: {
        reservations: [
          {
            inventory_item_id: inventoryItemId,
            location_id: LOCATION_ID,
            quantity: item.quantity,
            line_item_id: item.id,
            allow_backorder: true,
          },
        ],
      },
    });
  }

  const {
    createOrderFulfillmentWorkflow,
    markOrderFulfillmentAsDeliveredWorkflow,
  } = await import("@medusajs/core-flows");

  const fulfillResult = await createOrderFulfillmentWorkflow(container).run({
    input: {
      order_id: ORDER_ID,
      items: fulfillmentItems.map((item) => ({
        id: item.id,
        quantity: item.quantity,
      })),
      location_id: LOCATION_ID,
      no_notification: true,
      created_by: "manual-repair-order-1652",
    },
  });

  const fulfillment = fulfillResult.result as { id?: string };
  const fulfillmentId = fulfillment?.id;
  if (!fulfillmentId) {
    throw new Error("Fulfillment workflow returned no fulfillment id");
  }
  logger.info(`Created fulfillment ${fulfillmentId}`);

  for (const item of fulfillmentItems) {
    await pg.raw(
      `UPDATE order_item
          SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + ?::numeric),
              delivered_quantity = LEAST(quantity, COALESCE(delivered_quantity, 0) + ?::numeric)
        WHERE item_id = ?
          AND order_id = ?`,
      [item.quantity, item.quantity, item.id, ORDER_ID]
    );
  }

  await markOrderFulfillmentAsDeliveredWorkflow(container).run({
    input: { orderId: ORDER_ID, fulfillmentId },
  });

  await pg.raw(`UPDATE pos_invoice SET fulfillment_id = ? WHERE id = ?`, [
    fulfillmentId,
    INVOICE_ID,
  ]);

  const order = await orderModule.retrieveOrder(ORDER_ID, {
    select: ["id", "metadata"],
  });
  await orderModule.updateOrders(ORDER_ID, {
    metadata: {
      ...(order.metadata ?? {}),
      order_status: "Fulfilled",
      picked_up_at: new Date().toISOString(),
      picked_up_by: "manual-repair-order-1652",
    },
  });

  const afterRows = (
    await pg.raw(
      `SELECT
          COALESCE(SUM(ri.quantity), 0) AS reserved_qty,
          COUNT(ri.id) AS reservation_count
         FROM reservation_item ri
         JOIN order_item oi ON oi.item_id = ri.line_item_id
        WHERE oi.order_id = ?
          AND ri.deleted_at IS NULL`,
      [ORDER_ID]
    )
  ).rows as Array<{ reserved_qty: string; reservation_count: string }>;

  logger.info(
    `Repair complete. Open reserved quantity after repair: ${afterRows[0]?.reserved_qty ?? "0"} (${afterRows[0]?.reservation_count ?? "0"} reservation rows)`
  );
}
