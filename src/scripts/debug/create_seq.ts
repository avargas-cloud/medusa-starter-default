import { parse } from "dotenv"
import { readFileSync } from "fs"
import { Pool } from "pg"

const envConfig = parse(readFileSync('.env'))
const pool = new Pool({ connectionString: envConfig.DATABASE_URL })

async function check() {
    try {
        await pool.query('CREATE SEQUENCE IF NOT EXISTS custom_medusa_invoice_seq START 1000')
        console.log("Sequence created!")
    } catch(e) {
        console.error(e)
    } finally {
        await pool.end()
    }
}
check()
