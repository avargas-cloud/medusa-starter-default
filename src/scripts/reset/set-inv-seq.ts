import { Pool } from "pg"
import dotenv from "dotenv"
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
    try {
        console.log("Setting custom_invoice_seq to exactly 20000...")
        
        // We set to 19999 so the NEXT value dispensed is exactly 20000.
        await pool.query(`SELECT setval('custom_invoice_seq', 19999);`)
        console.log(`✅ custom_invoice_seq aligned! The next invoice created will be INV-20000.`)

    } catch (e) {
        console.error("Failed to set sequence:", e)
    } finally {
        await pool.end()
    }
}
run()
