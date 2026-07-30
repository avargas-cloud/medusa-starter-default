const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function run() {
  const result = await pool.query("SELECT id, invoice_number, total, amount_paid, balance_due, status FROM pos_invoice ORDER BY created_at DESC LIMIT 5")
  console.log(result.rows)
  pool.end()
  process.exit(0)
}
run()
