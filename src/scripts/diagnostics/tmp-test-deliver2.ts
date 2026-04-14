import { markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/core-flows";

export default async function queryPayments({ container }: { container: any }) {
  const fulfillmentId = "ful_01KMKXEYVZMXQFAG4YN4C1VCGP";
  const orderId = "order_01KMKWWRJX09VS52MM0NJX85ZW";

  try {
    console.log("Attempting markOrderFulfillmentAsDeliveredWorkflow...");
    await markOrderFulfillmentAsDeliveredWorkflow(container).run({
      input: {
        orderId: orderId,
        fulfillmentId: fulfillmentId,
      },
    });
    console.log("markOrderFulfillmentAsDeliveredWorkflow Success!");
  } catch (e: any) {
    console.error("markOrderFulfillmentAsDeliveredWorkflow Error:", e.message);
  }
}
