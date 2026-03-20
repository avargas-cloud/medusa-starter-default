require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = \'order_item\'').then(res => {
  console.log("ORDER ITEM:", res.rows.map(r => r.column_name).join(', '));
  process.exit(0);
}).catch(console.error);
