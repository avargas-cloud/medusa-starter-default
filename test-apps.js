const { Pool } = require('pg')

const pool = new Pool({
  connectionString: 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway',
  ssl: { rejectUnauthorized: false }
})

async function run() {
  try {
    const res = await pool.query("SELECT * FROM payment_application ORDER BY created_at DESC LIMIT 5")
    console.log("PAYMENT APPLICATIONS:", res.rows)
  } catch (err) {
    console.error(err)
  } finally {
    await pool.end()
    process.exit(0)
  }
}
run()
