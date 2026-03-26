import { parse } from "dotenv"
import { readFileSync } from "fs"
import { Pool } from "pg"

const envConfig = parse(readFileSync('.env'))
const pool = new Pool({ connectionString: envConfig.DATABASE_URL })

async function check() {
    try {
        const res = await pool.query('SELECT * FROM qb_sync_log ORDER BY initiated_at DESC LIMIT 5')
        console.log("=== LATEST QB SYNC LOGS ===")
        res.rows.forEach(r => console.log(JSON.stringify(r)))
    } catch(e) {
        console.error(e)
    } finally {
        await pool.end()
    }
}
check()
