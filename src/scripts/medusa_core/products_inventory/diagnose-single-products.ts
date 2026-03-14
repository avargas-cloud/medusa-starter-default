import { Client } from "pg"
import dotenv from "dotenv"

dotenv.config()

/**
 * Diagnostic Script: Single Product Options Issue
 * 
 * Identifies products that have:
 * - Exactly 1 variant
 * - Zero product options
 * These products need a "Title" option created
 */
async function diagnoseSingleProducts() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log("🔍 Diagnosing single variant products without options...")
        console.log("=".repeat(80))

        // Query: Find products with 1 variant and 0 options
        const result = await client.query(`
            WITH product_stats AS (
                SELECT 
                    p.id,
                    p.title,
                    p.handle,
                    p.metadata,
                    COUNT(DISTINCT po.id) as option_count,
                    COUNT(DISTINCT pv.id) as variant_count,
                    ARRAY_AGG(DISTINCT pv.id) FILTER (WHERE pv.id IS NOT NULL) as variant_ids,
                    ARRAY_AGG(DISTINCT pv.title) FILTER (WHERE pv.title IS NOT NULL) as variant_titles,
                    ARRAY_AGG(DISTINCT pv.sku) FILTER (WHERE pv.sku IS NOT NULL) as variant_skus
                FROM product p
                LEFT JOIN product_option po ON po.product_id = p.id AND po.deleted_at IS NULL
                LEFT JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
                WHERE p.deleted_at IS NULL
                GROUP BY p.id, p.title, p.handle, p.metadata
            )
            SELECT *
            FROM product_stats
            WHERE variant_count = 1 
              AND option_count = 0
            ORDER BY title
        `)

        const affectedProducts = result.rows

        console.log(`\n📊 DIAGNOSIS RESULTS`)
        console.log("=".repeat(80))
        console.log(`Total products with 1 variant and NO options: ${affectedProducts.length}`)

        if (affectedProducts.length === 0) {
            console.log("\n✅ No products need fixing - all single variant products have options!")
            return
        }

        console.log(`\n📋 Sample affected products (first 10):`)
        console.log("=".repeat(80))

        affectedProducts.slice(0, 10).forEach((product, idx) => {
            console.log(`\n${idx + 1}. ${product.title}`)
            console.log(`   ID: ${product.id}`)
            console.log(`   Handle: ${product.handle}`)
            console.log(`   Variant: ${product.variant_titles?.[0] || 'Untitled'}`)
            console.log(`   SKU: ${product.variant_skus?.[0] || 'No SKU'}`)
            console.log(`   WC Type: ${product.metadata?.wc_type || 'N/A'}`)
        })

        if (affectedProducts.length > 10) {
            console.log(`\n   ... and ${affectedProducts.length - 10} more products`)
        }

        // Categorize by WC type
        const byType = affectedProducts.reduce((acc, p) => {
            const type = p.metadata?.wc_type || 'unknown'
            acc[type] = (acc[type] || 0) + 1
            return acc
        }, {} as Record<string, number>)

        console.log(`\n📈 Breakdown by WooCommerce type:`)
        console.log("=".repeat(80))
        Object.entries(byType).forEach(([type, count]) => {
            console.log(`  ${type}: ${count} products`)
        })

        // Check for products managed by attributes system
        const managedByAttributes = affectedProducts.filter(p =>
            p.metadata?.managed_by === 'attributes'
        )

        if (managedByAttributes.length > 0) {
            console.log(`\n⚠️  WARNING: ${managedByAttributes.length} products managed by attributes system`)
            console.log(`   These should be SKIPPED during migration`)
        }

        console.log("\n" + "=".repeat(80))
        console.log("💡 NEXT STEPS:")
        console.log("   1. Review the sample products above")
        console.log("   2. Run fix script with --dry-run:")
        console.log("      yarn ts-node scripts/fix-single-product-options.ts --dry-run")
        console.log("   3. If looks good, run in LIVE mode:")
        console.log("      yarn ts-node scripts/fix-single-product-options.ts --live")
        console.log("=".repeat(80))

    } catch (error) {
        console.error("❌ Diagnosis failed:", error)
        throw error
    } finally {
        await client.end()
    }
}

diagnoseSingleProducts()
    .then(() => {
        console.log("\n✅ Diagnosis completed")
        process.exit(0)
    })
    .catch((err) => {
        console.error("\n❌ Fatal error:", err)
        process.exit(1)
    })
