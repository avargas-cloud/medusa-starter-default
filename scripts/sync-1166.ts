import { MedusaContainer } from "@medusajs/framework/types";
import qbOrderSubscriber from "../src/subscribers/qb-order-subscriber";

export default async function sync1166({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve("logger");
  const orderId = "order_01KM6TSB40YHKP7PCKM0CF2MR2";

  logger.info(`Manually triggering QB subscriber for Order: ${orderId}...`);

  await qbOrderSubscriber({
    event: {
      name: "order.fulfillment_created",
      data: { order_id: orderId, id: "manual_resync", items: [] },
    },
    container,
  } as any);

  logger.info(`Finished triggering subscriber!`);
}
