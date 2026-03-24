import { Pool } from "pg"
import dotenv from "dotenv"
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
    try {
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS custom_invoice_seq START 1000;`)
        console.log("Successfully created custom_invoice_seq!")
    } catch (e) {
        console.error(e)
    } finally {
        await pool.end()
    }
}
run()
