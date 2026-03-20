const { Pool } = require('pg')

const pool = new Pool({
  connectionString: 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway',
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
