import { Client } from "pg"
import dotenv from "dotenv"

dotenv.config()

async function migrateDescriptions(dryRun = true) {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log("🔄 Starting description migration to metadata.long_description...")
        console.log(`Mode: ${dryRun ? "DRY RUN (preview only)" : "LIVE (will update)"}`)
        console.log("=".repeat(60))

        // Fetch all products with descriptions
        const result = await client.query(`
            SELECT id, title, description, metadata
            FROM product
            WHERE deleted_at IS NULL
            ORDER BY created_at DESC
        `)

        const products = result.rows
        let totalProcessed = 0
        let totalMigrated = 0
        let skipped: string[] = []

        console.log(`\n📦 Found ${products.length} products total\n`)

        for (const product of products) {
            totalProcessed++

            // Skip if already has long_description
            if (product.metadata?.long_description) {
                console.log(`⏭️  Skipping "${product.title}" - already has long_description`)
                skipped.push(product.id)
                continue
            }

            // Skip if no description
            if (!product.description || product.description.trim() === "") {
                console.log(`⏭️  Skipping "${product.title}" - no description`)
                skipped.push(product.id)
                continue
            }

            console.log(`✅ Migrating: ${product.title}`)
            console.log(`   Description length: ${product.description.length} chars`)
            console.log(`   Preview: ${product.description.substring(0, 100)}...`)

            if (!dryRun) {
                // Update metadata with long_description
                const updatedMetadata = {
                    ...product.metadata,
                    long_description: product.description
                }

                await client.query(
                    `UPDATE product 
                     SET metadata = $1, updated_at = NOW()
                     WHERE id = $2`,
                    [JSON.stringify(updatedMetadata), product.id]
                )

                console.log(`   ✏️  Migrated to metadata.long_description`)
            }

            totalMigrated++
        }

        console.log("\n" + "=".repeat(60))
        console.log("📊 MIGRATION SUMMARY")
        console.log("=".repeat(60))
        console.log(`Total products processed: ${totalProcessed}`)
        console.log(`Products ${dryRun ? "to migrate" : "migrated"}: ${totalMigrated}`)
        console.log(`Products skipped: ${skipped.length}`)
        console.log("=".repeat(60))

        if (dryRun) {
            console.log("\n💡 This was a DRY RUN - no changes were made")
            console.log("   Run with --live to execute the migration")
        } else {
            console.log("\n✅ Migration completed!")
            console.log("   Next step: Import short_descriptions from WooCommerce")
        }
    } catch (error) {
        console.error("❌ Migration failed:", error)
        throw error
    } finally {
        await client.end()
    }
}

// Run script
const isLive = process.argv.includes("--live")
migrateDescriptions(!isLive)
    .then(() => {
        process.exit(0)
    })
    .catch((err) => {
        console.error("❌ Fatal error:", err)
        process.exit(1)
    })
