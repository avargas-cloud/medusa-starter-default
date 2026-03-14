const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query(`
    SELECT
      o.id as order_id,
      o.display_id,
      oi.id as item_id,
      oi.unit_price,
      oi.raw_unit_price,
      oi.quantity,
      oi.raw_quantity,
      oi.title
    FROM "order" o
    JOIN order_item oi ON oi.order_id = o.id
    ORDER BY o.created_at DESC LIMIT 1;
  `);

  const order = res.rows[0];
  console.log("=== ÚLTIMO ITEM EN BD PURA ===");
  console.log("Display ID:", order.display_id);
  console.log("Quantity Guardado:", order.quantity);
  console.log("Precio Guardado:", order.unit_price);
  await client.end();
}
run().catch(console.error);
