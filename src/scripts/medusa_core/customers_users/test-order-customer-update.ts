import { resolve } from "path";
import { initialize as initializeOrderModule } from "@medusajs/order";
import { Modules } from "@medusajs/utils";
import { config } from "dotenv";

config({ path: resolve(__dirname, "../.env") });

async function run() {
  const orderModule = await initializeOrderModule({
    database: {
      clientUrl: process.env.DATABASE_URL,
      driverOptions: {
        connection: { ssl: false },
      },
    },
  });

  const orderId = "order_01KKP94867YW6167D4J4T38441";
  const newCustomerId = "cus_01G3"; // We'll just try to change it to something and observe the DB result, or use the actual id from the screenshot for "Alexander Barrios" (which is prod_..., wait no cus_...).
  // Let's first just fetch the order
  let order = await orderModule.retrieveOrder(orderId, {
    relations: ["customer"],
  });
  console.log("Current customer:", order.customer_id);

  try {
    const updated = await orderModule.updateOrders({
      id: orderId,
      customer_id: "cus_01KKPGX3X1MWMDBXZ67H2Q9R42", // Valid customer ID (Jorge Carvajal from DB or whatever, let's just use `fetch` on /admin/customers later if we need a real ID, but this is a unit test wrapper)
    });
    console.log("Update success?", updated);
  } catch (e: any) {
    console.error("Update failed:", e.message);
  }
}

run().catch(console.error);
