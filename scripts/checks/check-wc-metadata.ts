import { Client } from "pg"
import dotenv from "dotenv"

dotenv.config()

async function checkMetadata() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log("🔍 Checking product metadata structure...")
        console.log("=".repeat(60))

        // Sample products with metadata
        const result = await client.query(`
            SELECT id, title, handle, metadata
            FROM product
            WHERE deleted_at IS NULL
              AND metadata IS NOT NULL
            LIMIT 10
        `)

        console.log(`\n📦 Sample products with metadata:\n`)
        result.rows.forEach((product, idx) => {
            console.log(`${idx + 1}. ${product.title}`)
            console.log(`   Handle: ${product.handle}`)
            console.log(`   Metadata keys: ${Object.keys(product.metadata || {}).join(", ")}`)
            if (product.metadata) {
                console.log(`   Has woocommerce_id: ${!!product.metadata.woocommerce_id}`)
                console.log(`   Has wc_id: ${!!product.metadata.wc_id}`)
                console.log(`   Has source_id: ${!!product.metadata.source_id}`)
            }
            console.log()
        })

        // Count products with same description
        const stats = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN description = metadata->>'long_description' THEN 1 END) as same_desc,
                COUNT(CASE WHEN description IS NULL OR description = '' THEN 1 END) as empty_desc
            FROM product
            WHERE deleted_at IS NULL
              AND metadata->>'long_description' IS NOT NULL
        `)

        console.log("=".repeat(60))
        console.log("📊 STATISTICS")
        console.log("=".repeat(60))
        console.log(`Total products with long_description: ${stats.rows[0].total}`)
        console.log(`Products where description = long_description: ${stats.rows[0].same_desc} ❌`)
        console.log(`Products with empty description: ${stats.rows[0].empty_desc}`)
        console.log("\n💡 Products with same description likely failed to sync short_description")
        console.log("=".repeat(60))

    } catch (error) {
        console.error("❌ Error:", error)
        throw error
    } finally {
        await client.end()
    }
}

checkMetadata()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Fatal error:", err)
        process.exit(1)
    })
