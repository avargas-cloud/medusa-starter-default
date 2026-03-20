const { Pool } = require('pg')

const pool = new Pool({
  connectionString: 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway',
  ssl: { rejectUnauthorized: false }
})

async function run() {
  const result = await pool.query("SELECT * FROM invoice_payment ORDER BY created_at DESC LIMIT 2")
  console.log('Invoice Payments:', result.rows)
  if (result.rows.length > 0) {
      const result2 = await pool.query("SELECT id, amount_paid, balance_due, status FROM pos_invoice WHERE id = $1", [result.rows[0].invoice_id])
      console.log('Target Invoice:', result2.rows)
  }
  pool.end()
}
run()
