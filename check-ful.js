require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = \'order_fulfillment\'').then(res => {
  console.log("FULFILLMENT:", res.rows.map(r => r.column_name).join(', '));
  process.exit(0);
}).catch(console.error);
