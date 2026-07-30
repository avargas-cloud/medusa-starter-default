const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL
});
client.connect().then(() => {
  return client.query(`
    SELECT *
    FROM "order"
    WHERE id = 'order_01KKAG16Q1WPFNTWMX9MV8MEFW';
  `);
}).then(res => {
  console.log(res.rows[0]);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
