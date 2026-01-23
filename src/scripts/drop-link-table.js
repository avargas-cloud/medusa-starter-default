
require('dotenv').config()
const { Client } = require('pg')

async function dropTable() {
    console.log("🔥 Attempting to DROP link table + Migrations via Raw SQL...")

    if (!process.env.DATABASE_URL) {
        console.error("❌ DATABASE_URL is missing in .env")
        return
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })

    try {
        await client.connect()

        // 1. DROP TABLE
        // Try known names
        const names = [
            "link_product_attribute_value",
            "product_product_productattributes_attribute_value",
            "product_attribute_value"
        ]

        for (const tableName of names) {
            console.log(`Checking table '${tableName}'...`)
            const res = await client.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1;
            `, [tableName])

            if (res.rows.length > 0) {
                console.log(`✅ Table '${tableName}' found. Dropping it...`)
                await client.query(`DROP TABLE "${tableName}" CASCADE;`)
                console.log("🗑️ Table DROPPED.")
            }
        }

        // 2. CLEAN MIGRATIONS (Critical!)
        console.log("🧹 Cleaning migration memory in link_module_migrations...")
        // Delete any record that looks like our link
        const resMig = await client.query(`
            DELETE FROM link_module_migrations 
            WHERE table_name LIKE '%product%attribute%'
            RETURNING table_name;
        `)

        if (resMig.rowCount > 0) {
            console.log(`🗑️ Deleted ${resMig.rowCount} migration records:`, resMig.rows.map(r => r.table_name))
        } else {
            console.log("⚠️ No matching migration records found (Maybe clean?).")
        }

    } catch (e) {
        console.error("SQL Error:", e)
    } finally {
        await client.end()
    }
}

dropTable()
