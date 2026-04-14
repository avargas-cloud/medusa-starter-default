import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Check what a VALID cart_line_item looks like
  const cartRes = await client.query(
    "SELECT unit_price, raw_unit_price, quantity, raw_quantity FROM cart_line_item LIMIT 1"
  );
  console.log("Valid Cart Item:", JSON.stringify(cartRes.rows[0], null, 2));

  // Check what our Order 1056 looks like
  const orderRes = await client.query(
    'SELECT oi.unit_price, oi.raw_unit_price, oi.quantity, oi.raw_quantity FROM order_item oi JOIN "order" o ON oi.order_id = o.id WHERE o.display_id = 1056'
  );
  console.log("Order 1056 Item:", JSON.stringify(orderRes.rows[0], null, 2));

  await client.end();
}
run().catch(console.error);
