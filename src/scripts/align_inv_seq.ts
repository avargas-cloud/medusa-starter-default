import { Pool } from "pg"
import dotenv from "dotenv"
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
    try {
        console.log("Analyzing highest existing invoice number...")
        // 1. Fetch the absolute maximum invoice number from the database.
        // Invoices are likely stored in a custom table if we built a module, or we can look for numbers.
        // If it's the standard Medusa structure, let's search if there's a custom invoice table.
        // Actually, we built `fin_invoice` or `invoice` in the Finance module. Let's find out!
        
        let maxQuery = await pool.query(`
            SELECT MAX(CAST(regexp_replace(invoice_number, '[^0-9]', '', 'g') AS INTEGER)) as max_num 
            FROM fin_invoice
            WHERE invoice_number ~ '[0-9]'
        `).catch(() => null)
        
        // Let's also check if it might be just 'invoice' depending on the table name
        if (!maxQuery) {
            maxQuery = await pool.query(`
                SELECT MAX(CAST(regexp_replace(invoice_number, '[^0-9]', '', 'g') AS INTEGER)) as max_num 
                FROM invoice
                WHERE invoice_number ~ '[0-9]'
            `).catch(() => null)
        }

        const maxNum = maxQuery?.rows?.[0]?.max_num

        let nextNum = 1000
        if (maxNum && !isNaN(maxNum) && maxNum >= 1000) {
            nextNum = Number(maxNum) + 1
            console.log(`Found existing invoices up to ${maxNum}. Setting sequence to start at ${nextNum}.`)
        } else {
            console.log(`No existing high invoices found. Sequence will safely start at ${nextNum}.`)
        }

        // 2. Set the sequence
        await pool.query(`SELECT setval('custom_invoice_seq', ${Math.max(nextNum - 1, 999)});`)
        console.log(`✅ custom_invoice_seq successfully aligned to dispense ${nextNum} next!`)

    } catch (e) {
        console.error("Failed to align sequence:", e)
    } finally {
        await pool.end()
    }
}
run()
