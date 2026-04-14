import { Pool } from "pg";
import { config } from "dotenv";
config();

async function run() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Please provide an order id");
    process.exit(1);
  }

  console.log(`Resetting item fulfilled quantity to 0 for order ${orderId}...`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // 1. Try updating order_line_item which has order_id
  const res1 = await pool
    .query(
      `UPDATE order_line_item SET fulfilled_quantity = 0 WHERE order_id = $1`,
      [orderId]
    )
    .catch(() => ({ rowCount: 0 }));
  console.log(`order_line_item rowCount: ${res1.rowCount}`);

  // 2. Try updating order_item via join
  const res2 = await pool
    .query(
      `
    UPDATE order_item 
    SET fulfilled_quantity = 0, delivered_quantity = 0 
    WHERE id IN (
        SELECT item_id FROM order_line_item WHERE order_id = $1
    )
  `,
      [orderId]
    )
    .catch((e) => {
      console.error(e);
      return { rowCount: 0 };
    });
  console.log(`order_item rowCount: ${res2.rowCount}`);

  console.log(`Successfully reset!`);
  process.exit(0);
}

run().catch(console.error);
