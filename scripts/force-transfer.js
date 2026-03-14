const { resolve } = require("path");
const { initialize } = require("@medusajs/order");
require("dotenv").config({ path: resolve(__dirname, "../.env") });

async function run() {
  const orderModule = await initialize({
    database: {
      clientUrl: process.env.DATABASE_URL,
      driverOptions: { connection: { ssl: false } }
    }
  });

  const orderId = "order_01KKP94867YW6167D4J4T38441";
  
  // Find a customer ID from the DB
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT id FROM customer LIMIT 2");
  const newCustomerId = rows[0].id; // just pick one
  
  console.log("Attempting to transfer order", orderId, "to customer", newCustomerId);

  try {
    const updated = await orderModule.updateOrders({
      id: orderId,
      customer_id: newCustomerId
    });
    console.log("Update success!");
    console.log("New customer ID on order:", updated[0].customer_id);
  } catch (e) {
    console.error("Update failed:", e.message);
  }

  pool.end();
}
run();
