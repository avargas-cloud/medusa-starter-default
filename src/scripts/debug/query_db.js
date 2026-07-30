const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL
});
client.connect().then(() => {
  return client.query(`
    SELECT 
        oli.title, 
        oli.unit_price, 
        oi.quantity, 
        oi.detail->>'subtotal' as subtotal,
        oi.detail->>'discount_total' as discount_total,
        oi.detail->>'tax_total' as tax_total,
        oi.detail->>'total' as total
    FROM "order_item" oi
    JOIN "order_line_item" oli ON oi.item_id = oli.id
    WHERE oi.order_id = 'order_01KKAG16Q1WPFNTWMX9MV8MEFW';
  `);
}).then(res => {
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
