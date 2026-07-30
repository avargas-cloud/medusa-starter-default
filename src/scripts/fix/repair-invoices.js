const { Pool } = require('pg')
// SANDBOX ONLY, fail-closed. Added 2026-07-30 when this file was moved out of the
// backend repo ROOT, where it had sat for four months with the production Postgres
// URL hardcoded — `node repair-invoices.js` from that directory would have run the
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
  // Step 1: Find all invoices with payments
  const invoices = await pool.query("SELECT id, total FROM pos_invoice WHERE status != 'voided'")
  let updated = 0
  for (const inv of invoices.rows) {
      const payments = await pool.query("SELECT SUM(amount) as total_paid FROM invoice_payment WHERE invoice_id = $1", [inv.id])
      const totalPaid = Number(payments.rows[0].total_paid) || 0;
      const total = Number(inv.total) || 0;
      const balanceDue = Math.max(0, total - totalPaid);
      
      const newStatus = balanceDue <= 0 ? 'paid' : (totalPaid > 0 ? 'partial' : 'issued');

      await pool.query(
          "UPDATE pos_invoice SET amount_paid = $1, balance_due = $2, status = $3 WHERE id = $4",
          [totalPaid, balanceDue, newStatus, inv.id]
      )
      updated++;
  }
  console.log(`Successfully recalculated and repaired ${updated} invoices.`)
  pool.end()
}
run()
