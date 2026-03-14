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
    slug: string
    short_description: string
    name: string
}

interface MatchResult {
    strategy: "wc_id" | "handle" | "sku" | "none"
    medusa_id?: string
    medusa_title?: string
}

/**
 * Enhanced WooCommerce Short Description Re-sync
 * 
 * Matching Strategies (in order of priority):
 * 1. WooCommerce ID (metadata.wc_id) - PRIMARY
 * 2. Handle/Slug matching - FALLBACK for variable products
 * 3. SKU matching (variant-level) - LAST RESORT for simple products
 */
async function importShortDescriptionsEnhanced(dryRun = true, targetFailed = false) {
    const pgClient = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await pgClient.connect()
        console.log("🔄 Starting ENHANCED WooCommerce short_description re-sync...")
        console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update)"}`)
        if (targetFailed) {
            console.log(`Target: ONLY products where description = long_description (failed syncs)`)
        }
        console.log("=".repeat(80))

        let page = 1
        let hasMore = true
        let totalProcessed = 0
        let stats = {
            matched_by_wc_id: 0,
            matched_by_handle: 0,
            matched_by_sku: 0,
            not_found: [] as string[],
            no_short_desc: [] as string[],
            skipped_already_synced: 0,
            updated: 0
        }

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

                    // Skip if no short_description
                    if (!wcProduct.short_description || wcProduct.short_description.trim() === "") {
                        stats.no_short_desc.push(`${wcProduct.id}`)
                        continue
                    }

                    // Try to find Medusa product using multiple strategies
                    const match = await findMedusaProduct(
                        pgClient,
                        wcProduct,
                        targetFailed
                    )

                    if (!match.medusa_id) {
                        stats.not_found.push(`WC:${wcProduct.id} (${wcProduct.name})`)
                        console.log(`❌ Not found: WC ID ${wcProduct.id} - ${wcProduct.name}`)
                        continue
                    }

                    // Log match
                    console.log(`✅ Match via ${match.strategy.toUpperCase()}: WC:${wcProduct.id} → ${match.medusa_title}`)
                    console.log(`   Short desc: ${wcProduct.short_description.substring(0, 80)}...`)

                    // Update statistics
                    if (match.strategy === "wc_id") stats.matched_by_wc_id++
                    else if (match.strategy === "handle") stats.matched_by_handle++
                    else if (match.strategy === "sku") stats.matched_by_sku++

                    if (!dryRun) {
                        // Update Medusa product description
                        await pgClient.query(
                            `UPDATE product 
                             SET description = $1, updated_at = NOW()
                             WHERE id = $2`,
                            [wcProduct.short_description, match.medusa_id]
                        )
                        console.log(`   ✏️  Updated description`)
                    }

                    stats.updated++
                }

                page++
            } catch (error: any) {
                console.error(`❌ Error on page ${page}:`, error.message)
                break
            }
        }

        printSummary(stats, totalProcessed, dryRun)

    } catch (error) {
        console.error("❌ Re-sync failed:", error)
        throw error
    } finally {
        await pgClient.end()
    }
}

/**
 * Find Medusa product using multiple matching strategies
 */
async function findMedusaProduct(
    client: Client,
    wcProduct: WooProduct,
    targetFailed: boolean
): Promise<MatchResult> {

    // Build failed products filter
    const failedFilter = targetFailed
        ? `AND description = (metadata->>'long_description')`
        : ''

    // Strategy 1: Match by WooCommerce ID (PRIMARY - most reliable)
    try {
        const result = await client.query(
            `SELECT id, title, handle 
             FROM product 
             WHERE deleted_at IS NULL
               AND metadata->>'wc_id' = $1
               ${failedFilter}
             LIMIT 1`,
            [wcProduct.id.toString()]
        )

        if (result.rows.length > 0) {
            return {
                strategy: "wc_id",
                medusa_id: result.rows[0].id,
                medusa_title: result.rows[0].title
            }
        }
    } catch (err) {
        console.warn(`⚠️ WC ID match failed for ${wcProduct.id}`)
    }

    // Strategy 2: Match by handle/slug (FALLBACK - for variable products)
    try {
        const result = await client.query(
            `SELECT id, title, handle 
             FROM product 
             WHERE deleted_at IS NULL
               AND handle = $1
               ${failedFilter}
             LIMIT 1`,
            [wcProduct.slug]
        )

        if (result.rows.length > 0) {
            return {
                strategy: "handle",
                medusa_id: result.rows[0].id,
                medusa_title: result.rows[0].title
            }
        }
    } catch (err) {
        console.warn(`⚠️ Handle match failed for ${wcProduct.slug}`)
    }

    // Strategy 3: Match by SKU (LAST RESORT - for simple products only)
    if (wcProduct.sku) {
        try {
            const result = await client.query(
                `SELECT p.id, p.title, p.handle 
                 FROM product p
                 WHERE p.deleted_at IS NULL
                   AND EXISTS (
                       SELECT 1 FROM product_variant pv 
                       WHERE pv.product_id = p.id 
                       AND pv.sku = $1
                       AND pv.deleted_at IS NULL
                   )
                   ${failedFilter}
                 LIMIT 1`,
                [wcProduct.sku]
            )

            if (result.rows.length > 0) {
                return {
                    strategy: "sku",
                    medusa_id: result.rows[0].id,
                    medusa_title: result.rows[0].title
                }
            }
        } catch (err) {
            console.warn(`⚠️ SKU match failed for ${wcProduct.sku}`)
        }
    }

    // No match found
    return { strategy: "none" }
}

function printSummary(stats: any, totalProcessed: number, dryRun: boolean) {
    console.log("\n" + "=".repeat(80))
    console.log("📊 RE-SYNC SUMMARY")
    console.log("=".repeat(80))
    console.log(`Total WooCommerce products processed: ${totalProcessed}`)
    console.log(`\n🎯 MATCHING STRATEGIES:`)
    console.log(`  ✅ Matched by WC ID (metadata.wc_id):  ${stats.matched_by_wc_id}`)
    console.log(`  ✅ Matched by Handle/Slug (fallback):  ${stats.matched_by_handle}`)
    console.log(`  ✅ Matched by SKU (last resort):       ${stats.matched_by_sku}`)
    console.log(`  ❌ Not found in Medusa:                ${stats.not_found.length}`)
    console.log(`  ⏭️  No short_description in WC:        ${stats.no_short_desc.length}`)

    console.log(`\n📝 RESULTS:`)
    console.log(`  Products ${dryRun ? "to update" : "updated"}: ${stats.updated}`)

    if (stats.not_found.length > 0 && stats.not_found.length <= 20) {
        console.log(`\n📋 Products not found in Medusa:`)
        stats.not_found.forEach((item: string) => console.log(`  - ${item}`))
    } else if (stats.not_found.length > 20) {
        console.log(`\n📋 First 20 products not found:`)
        stats.not_found.slice(0, 20).forEach((item: string) => console.log(`  - ${item}`))
        console.log(`  ... and ${stats.not_found.length - 20} more`)
    }

    console.log("\n" + "=".repeat(80))

    if (dryRun) {
        console.log("\n💡 This was a DRY RUN - no changes were made")
        console.log("   Run with --live to execute the re-sync")
        console.log("   Add --failed-only to target only products that failed previously")
    } else {
        console.log("\n✅ Re-sync completed!")
        console.log("   Refresh the Admin to see updated descriptions")
    }
}

// Run script
const isDryRun = !process.argv.includes("--live")
const targetFailed = process.argv.includes("--failed-only")

importShortDescriptionsEnhanced(isDryRun, targetFailed)
    .then(() => {
        console.log("\n✅ Script completed successfully")
        process.exit(0)
    })
    .catch((err) => {
        console.error("\n❌ Script failed:", err)
        process.exit(1)
    })
