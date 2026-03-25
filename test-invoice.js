require('dotenv').config()
const { getDbPool } = require('./src/api/utils/db-pool')

async function run() {
    const pool = getDbPool()
    try {
        const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice'`)
        console.log("Invoice tables columns:", res.rows.map(r => r.column_name))
    } catch(e) { console.error(e) }
    process.exit(0)
}
run()
