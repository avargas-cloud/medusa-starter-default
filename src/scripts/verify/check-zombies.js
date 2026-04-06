require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL
});
async function run() {
  await client.connect();
  const res = await client.query(`
    SELECT ri.id, ri.quantity, ri.description, ri.created_at::date, ri.line_item_id, pv.sku, li.order_id 
    FROM reservation_item ri 
    JOIN inventory_item ii ON ii.id=ri.inventory_item_id 
    JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id=ii.id 
    JOIN product_variant pv ON pv.id=pvii.variant_id 
    LEFT JOIN order_item li ON li.id=ri.line_item_id 
    WHERE pv.sku='EAP-AS1-8S' AND ri.deleted_at IS NULL 
    ORDER BY ri.created_at DESC;
  `);
  console.table(res.rows);
  await client.end();
}
run().catch(e => { console.error(e); process.exit(1); });
