import { initialize } from "../../../../medusa-config";
import { Modules } from "@medusajs/utils";

async function run() {
  const { container } = await initialize();
  const orderModule = container.resolve(Modules.ORDER) as any;

  const orders = await orderModule.listOrders(
    {},
    { relations: ["shipping_methods"], take: 1 }
  );
  if (!orders.length) return console.log("No orders");
  const order = orders[0];

  console.log(
    "Order:",
    order.id,
    "Shipping Methods:",
    order.shipping_methods?.map((sm: any) => ({ id: sm.id, amount: sm.amount }))
  );

  if (order.shipping_methods?.length) {
    const smId = order.shipping_methods[0].id;
    try {
      if (typeof orderModule.updateOrderShippingMethods === "function") {
        console.log("Has updateOrderShippingMethods");
      } else if (typeof orderModule.updateShippingMethods === "function") {
        console.log("Has updateShippingMethods");
      } else {
        console.log(
          "Available methods:",
          Object.keys(orderModule).filter((k) =>
            k.toLowerCase().includes("ship")
          )
        );
      }
    } catch (e) {
      console.error(e);
    }
  }
  process.exit(0);
}

run();
