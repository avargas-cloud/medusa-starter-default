const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway'
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
