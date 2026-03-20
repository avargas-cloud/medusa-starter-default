const { Pool } = require('pg')

const pool = new Pool({
  connectionString: 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway',
  ssl: { rejectUnauthorized: false }
})

async function run() {
  console.log("Starting full financial wipe...")

  // Delete all AR applications and ledger entries
  await pool.query("DELETE FROM payment_application")
  await pool.query("DELETE FROM invoice_payment")
  await pool.query("DELETE FROM customer_payment")
  await pool.query("DELETE FROM pos_payment") // native fallback just in case

  // Reset all invoices to their original status
  await pool.query("UPDATE pos_invoice SET amount_paid = 0, balance_due = total, status = 'issued'")

  console.log("All payments have been purged. Invoices reset to issued state.")
  pool.end()
}
run().catch(console.error)
