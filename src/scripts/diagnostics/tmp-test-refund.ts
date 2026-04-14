import { MedusaRequest } from "@medusajs/framework/http";

export default async function queryPayments({ container }: { container: any }) {
  const query = container.resolve("query");
  const order_id = "order_01KMKWWRJX09VS52MM0NJX85ZW";

  console.log(`Querying order ${order_id}...`);
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: [
      "payment_collections.payments.id",
      "payment_collections.payments.amount",
      "payment_collections.payments.captures.*",
      "payment_collections.payments.refunds.*",
    ],
    filters: { id: order_id },
  });

  console.log("Order Data:", JSON.stringify(order, null, 2));

  if (order?.payment_collections?.length) {
    let amountToRefund = 85.05;
    for (const pc of order.payment_collections) {
      for (const payment of pc.payments || []) {
        const totalCaptured = (payment.captures || []).reduce(
          (sum: number, c: any) => sum + Number(c.amount),
          0
        );
        const totalRefunded = (payment.refunds || []).reduce(
          (sum: number, r: any) => sum + Number(r.amount),
          0
        );
        const availableToRefund = totalCaptured - totalRefunded;

        console.log(
          `Payment ${payment.id} | Captured: ${totalCaptured} | Refunded: ${totalRefunded} | Available: ${availableToRefund}`
        );
      }
    }
  }
}
