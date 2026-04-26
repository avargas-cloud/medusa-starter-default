import * as dotenv from "dotenv";
import { Pool } from "pg";
dotenv.config();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/medusa",
});

async function check() {
  try {
    const orderId = "order_01KMKWWRJX09VS52MM0NJX85ZW";

    const opcRes = await pool.query(
      "SELECT payment_collection_id FROM order_payment_collection WHERE order_id = $1",
      [orderId]
    );
    console.log("Order Payment Collections:", opcRes.rows);

    if (opcRes.rows.length) {
      for (const r of opcRes.rows) {
        const p = await pool.query(
          "SELECT id, amount, captured_amount, refunded_amount FROM payment WHERE payment_collection_id = $1",
          [r.payment_collection_id]
        );
        console.log(
          "Payments for collection",
          r.payment_collection_id,
          ":",
          p.rows
        );
      }
    }
  } finally {
    await pool.end();
  }
}
check();
