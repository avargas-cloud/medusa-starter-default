import { MedusaContainer } from "@medusajs/framework/types";
import qbOrderSubscriber from "../src/subscribers/qb-order-subscriber";

export default async function syncInvoice({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve("order");
  const invoiceModule = container.resolve("invoice");

  // 1. Fetch Order 1176
  const orders = await orderModule.listOrders({ display_id: 1176 });
  if (!orders || orders.length === 0) {
    logger.error("Order 1176 not found!");
    return;
  }
  const orderId = orders[0].id;
  logger.info(`Found Order 1176 with ID: ${orderId}`);

  // 2. Fetch the latest Invoice for this Order
  const invoices = await invoiceModule.listInvoices({ order_id: orderId });
  if (!invoices || invoices.length === 0) {
    logger.error("No invoices found for Order 1176!");
    return;
  }

  // Assuming the newest invoice is the last one in the list or just the first one. Let's send all or the last one.
  const latestInvoice = invoices[invoices.length - 1];
  const invoiceId = latestInvoice.id;
  logger.info(`Found Invoice for Order 1176: ${invoiceId}`);

  // 3. Trigger Subscriber Manually
  logger.info(`Manually triggering QB subscriber for Invoice: ${invoiceId}...`);

  await qbOrderSubscriber({
    event: {
      name: "pos.invoice.created",
      data: { invoice_id: invoiceId },
    },
    container,
  } as any);

  logger.info(
    `Finished triggering subscriber! Check the Quickbooks bridge queue now.`
  );
}
