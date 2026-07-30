const { Pool } = require('pg')
// SANDBOX ONLY, fail-closed. Added 2026-07-30 when this file was moved out of the
// backend repo ROOT, where it had sat for four months with the production Postgres
// URL hardcoded — `node purge-payments.js` from that directory would have run the
// statements below against production. It has no dry run, no APPLY flag and no
// WHERE clause, so the guard is the only thing between it and the payment ledger.
// Per the repo rules a destructive write goes to the Docker sandbox first.
const DB = process.env.DATABASE_URL || ''
if (!DB.includes(':5499')) {
  console.error('REFUSING — this script only runs against the Docker sandbox (port 5499).')
  console.error('  DATABASE_URL points somewhere else. See docs/SANDBOX.md.')
  process.exit(2)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
