const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function debug() {
  const oRes = await pool.query('SELECT id, display_id FROM "order" WHERE display_id = 1096');
  if (!oRes.rows[0]) {
    console.log("Order 1096 not found in remote DB.");
    return;
  }
  const orderId = oRes.rows[0].id;
  
  const sumRes = await pool.query('SELECT totals FROM order_summary WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1', [orderId]);
  console.log('Order Summary Totals:', JSON.stringify(sumRes.rows[0]?.totals, null, 2));

  const itemsRes = await pool.query('SELECT item_id, unit_price, quantity, title FROM order_item WHERE order_id = $1 ORDER BY version DESC', [orderId]);
  console.log('Items:', itemsRes.rows);

  const adjRes = await pool.query(`
    SELECT a.id, a.item_id, a.amount, a.code
    FROM order_line_item_adjustment a
    JOIN order_item oi ON a.item_id = oi.item_id
    WHERE oi.order_id = $1 AND a.deleted_at IS NULL
  `, [orderId]);
  console.log('Adjustments:', adjRes.rows);
  
  const taxRes = await pool.query(`
    SELECT t.item_id, t.rate, t.code
    FROM order_line_item_tax_line t
    JOIN order_item oi ON t.item_id = oi.item_id
    WHERE oi.order_id = $1 AND t.deleted_at IS NULL
  `, [orderId]);
  console.log('Tax Lines:', taxRes.rows);

  const promoRes = await pool.query(`
    SELECT code, application_method_id FROM promotion
    WHERE code LIKE 'POS-DISC-%' ORDER BY created_at DESC LIMIT 1
  `);
  if (promoRes.rows[0]) {
    const amRes = await pool.query(`SELECT type, target_type, value FROM promotion_application_method WHERE id = $1`, [promoRes.rows[0].application_method_id]);
    console.log('Latest Promotion:', promoRes.rows[0].code, amRes.rows[0]);
  }

  await pool.end();
}

debug().catch(console.error);
