import { Pool } from "pg";

async function run() {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const items = await pool.query(
      'SELECT unit_price, quantity, subtotal, tax_total, total FROM "order_item" WHERE order_id = (SELECT id FROM "order" WHERE display_id = 1020)'
    );
    console.table(items.rows);
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

run();
