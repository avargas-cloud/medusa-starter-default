import { Pool } from "pg"

async function run() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL || "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway",
        ssl: { rejectUnauthorized: false }
    })

    try {
        const res = await pool.query(`SELECT currency_code, amount, min_quantity, max_quantity, price_list_id, rules_count FROM price WHERE price_set_id = 'pset_01KFRD6XMX1KYCTZAZ1CA0Y2EC'`)
        console.table(res.rows)

        const prefRes = await pool.query(`SELECT id, title FROM price_list WHERE id IN (SELECT price_list_id FROM price WHERE price_set_id = 'pset_01KFRD6XMX1KYCTZAZ1CA0Y2EC' AND price_list_id IS NOT NULL)`)
        console.table(prefRes.rows)

    } catch (e: any) {
        console.error("Test Error:", e.message || e)
    } finally {
        await pool.end()
    }
}

run()
