import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api"
import { Client } from "pg"
import dotenv from "dotenv"

dotenv.config()

const WooCommerce = new WooCommerceRestApi({
    url: process.env.WC_URL!,
    consumerKey: process.env.WC_CONSUMER_KEY!,
    consumerSecret: process.env.WC_CONSUMER_SECRET!,
    version: "wc/v3"
})

interface WooProduct {
    id: number
    sku: string
    short_description: string
    name: string
}

async function importShortDescriptions(dryRun = true) {
    const pgClient = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await pgClient.connect()
        console.log("🔄 Starting WooCommerce short_description import...")
        console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update)"}`)
        console.log("=".repeat(60))

        let page = 1
        let hasMore = true
        let totalProcessed = 0
        let totalUpdated = 0
        let notFound: string[] = []
        let noShortDesc: string[] = []

        while (hasMore) {
            try {
                // Fetch WooCommerce products
                const response = await WooCommerce.get("products", {
                    per_page: 100,
                    page
                })

                const products: WooProduct[] = response.data

                if (products.length === 0) {
                    hasMore = false
                    break
                }

                console.log(`\n📦 Processing page ${page} (${products.length} products)`)

                for (const wcProduct of products) {
                    totalProcessed++

                    if (!wcProduct.sku) {
                        console.log(`⚠️  Skipping "${wcProduct.name}" - no SKU`)
                        continue
                    }

                    if (!wcProduct.short_description || wcProduct.short_description.trim() === "") {
                        noShortDesc.push(wcProduct.sku)
                        continue
                    }

                    // Find Medusa product by SKU
                    const result = await pgClient.query(
                        `SELECT id, title, handle 
                         FROM product 
                         WHERE deleted_at IS NULL
                         AND EXISTS (
                             SELECT 1 FROM product_variant pv 
                             WHERE pv.product_id = product.id 
                             AND pv.sku = $1
                             AND pv.deleted_at IS NULL
                         )
                         LIMIT 1`,
                        [wcProduct.sku]
                    )

                    if (result.rows.length === 0) {
                        notFound.push(wcProduct.sku)
                        console.log(`❌ SKU ${wcProduct.sku} not found in Medusa`)
                        continue
                    }

                    const medusaProduct = result.rows[0]
                    console.log(`✅ Match: ${wcProduct.sku} → ${medusaProduct.title}`)
                    console.log(`   Short desc length: ${wcProduct.short_description.length} chars`)

                    if (!dryRun) {
                        // Update Medusa product description
                        await pgClient.query(
                            `UPDATE product 
                             SET description = $1, updated_at = NOW()
                             WHERE id = $2`,
                            [wcProduct.short_description, medusaProduct.id]
                        )
                        console.log(`   ✏️  Updated description`)
                    }

                    totalUpdated++
                }

                page++
            } catch (error) {
                console.error(`❌ Error on page ${page}:`, error)
                break
            }
        }

        console.log("\n" + "=".repeat(60))
        console.log("📊 IMPORT SUMMARY")
        console.log("=".repeat(60))
        console.log(`Total WooCommerce products processed: ${totalProcessed}`)
        console.log(`Products ${dryRun ? "to update" : "updated"}: ${totalUpdated}`)
        console.log(`Products not found in Medusa: ${notFound.length}`)
        console.log(`Products without short_description: ${noShortDesc.length}`)

        if (notFound.length > 0 && notFound.length <= 20) {
            console.log(`\n📋 SKUs not found in Medusa:`)
            notFound.forEach(sku => console.log(`  - ${sku}`))
        } else if (notFound.length > 20) {
            console.log(`\n📋 First 20 SKUs not found:`)
            notFound.slice(0, 20).forEach(sku => console.log(`  - ${sku}`))
            console.log(`  ... and ${notFound.length - 20} more`)
        }

        console.log("\n" + "=".repeat(60))

        if (dryRun) {
            console.log("\n💡 This was a DRY RUN - no changes were made")
            console.log("   Run without --dry-run to execute the import")
        } else {
            console.log("\n✅ Import completed!")
            console.log("   Refresh the Admin to see updated short descriptions")
        }
    } catch (error) {
        console.error("❌ Import failed:", error)
        throw error
    } finally {
        await pgClient.end()
    }
}

// Run script
const isDryRun = process.argv.includes("--dry-run")
importShortDescriptions(isDryRun)
    .then(() => {
        console.log("✅ Script completed")
        process.exit(0)
    })
    .catch((err) => {
        console.error("❌ Script failed:", err)
        process.exit(1)
    })
