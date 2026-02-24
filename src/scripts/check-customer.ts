import { Pool } from "pg"
import { config } from "dotenv"
import { resolve } from "path"
import * as jwt from "jsonwebtoken"

config({ path: resolve(__dirname, "../../../.env") })

async function run() {
    console.log("Looking up customer team@vedors.com...")
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })

    try {
        const res = await pool.query(`SELECT id, email FROM customer WHERE email = 'team@vedors.com'`)
        const customer = res.rows[0]
        if (!customer) {
            console.log("Customer not found")
            return
        }

        console.log("Customer ID:", customer.id)

        // Generate Token
        // Medusa JWT tokens contain actor_id = customer_id
        const JWT_SECRET = process.env.JWT_SECRET || "k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg"
        const token = jwt.sign({ actor_id: customer.id, action: "customer" }, JWT_SECRET, { expiresIn: "1h" })

        console.log("Generated Token:", token)

    } catch (e) {
        console.error(e)
    } finally {
        await pool.end()
    }
}

run()
