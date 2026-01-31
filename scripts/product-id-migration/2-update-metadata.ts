/**
 * Phase 2: Update Metadata with New Product IDs
 * 
 * Purpose:
 * - Update category sorting_config.product_order arrays
 * - Replace old handle-based IDs with new ULIDs
 * - Must run BEFORE database migration
 * 
 * Usage:
 *   npx tsx scripts/product-id-migration/2-update-metadata.ts
 */

import dotenv from "dotenv"
dotenv.config()

import knex from "knex"
import fs from "fs"
import path from "path"

const DB_URL = process.env.DATABASE_URL!

async function main() {
    console.log("🚀 Product ID Migration - Phase 2: Update Metadata\n")

    const db = knex({
        client: "pg",
        connection: DB_URL,
    })

    try {
        // 1. Load mappings from database
        console.log("📋 Loading ID mappings...")
        const mappings = await db("product_id_migration")
            .select("old_id", "new_id")

        if (mappings.length === 0) {
            console.log("❌ No mappings found! Run Phase 1 first.")
            process.exit(1)
        }

        const idMap = new Map(mappings.map(m => [m.old_id, m.new_id]))
        console.log(`✅ Loaded ${idMap.size} mappings\n`)

        // 2. Fetch categories with sorting_config
        console.log("🔍 Fetching categories with product sorting...")
        const categories = await db("product_category")
            .select("id", "name", "handle", "metadata")
            .whereRaw("metadata->>'sorting_config' IS NOT NULL")

        console.log(`📦 Found ${categories.length} categories with sorting config\n`)

        if (categories.length === 0) {
            console.log("ℹ️  No categories have sorting configurations to update")
            await db.destroy()
            return
        }

        // 3. Update each category's product_order
        let updateCount = 0
        let unchangedCount = 0
        const updates: Array<{
            category: string
            oldIds: string[]
            newIds: string[]
        }> = []

        for (const category of categories) {
            const metadata = category.metadata || {}
            const sortingConfig = metadata.sorting_config || {}
            const productOrder = sortingConfig.product_order || []

            if (productOrder.length === 0) {
                unchangedCount++
                continue
            }

            // Map old IDs to new IDs
            const newProductOrder = productOrder.map((oldId: string) => {
                const newId = idMap.get(oldId)
                if (!newId) {
                    console.log(`⚠️  Warning: No mapping found for ${oldId} in category "${category.name}"`)
                    return oldId // Keep original if no mapping (shouldn't happen)
                }
                return newId
            })

            // Check if anything changed
            const hasChanges = productOrder.some((id: string, idx: number) =>
                id !== newProductOrder[idx]
            )

            if (!hasChanges) {
                unchangedCount++
                continue
            }

            // Update metadata
            const newMetadata = {
                ...metadata,
                sorting_config: {
                    ...sortingConfig,
                    product_order: newProductOrder
                }
            }

            await db("product_category")
                .where({ id: category.id })
                .update({ metadata: JSON.stringify(newMetadata) })

            updateCount++
            updates.push({
                category: `${category.name} (${category.handle})`,
                oldIds: productOrder,
                newIds: newProductOrder
            })

            console.log(`✅ Updated: ${category.name}`)
            console.log(`   Products: ${productOrder.length}`)
            console.log(`   Old IDs: ${productOrder.slice(0, 2).join(", ")}${productOrder.length > 2 ? "..." : ""}`)
            console.log(`   New IDs: ${newProductOrder.slice(0, 2).join(", ")}${newProductOrder.length > 2 ? "..." : ""}\n`)
        }

        // 4. Save update log
        const logPath = path.join(process.cwd(), "scripts/product-id-migration/metadata-updates.json")
        fs.writeFileSync(
            logPath,
            JSON.stringify(updates, null, 2),
            "utf-8"
        )

        // 5. Summary
        console.log("─".repeat(80))
        console.log("✅ PHASE 2 COMPLETE\n")
        console.log("Summary:")
        console.log(`  - Categories processed: ${categories.length}`)
        console.log(`  - Categories updated: ${updateCount}`)
        console.log(`  - Categories unchanged: ${unchangedCount}`)
        console.log(`  - Update log: ${logPath}`)
        console.log()
        console.log("Next steps:")
        console.log("  1. Review metadata-updates.json")
        console.log("  2. Verify categories in Admin UI still show correct sorting")
        console.log("  3. Run: npx tsx scripts/product-id-migration/3-migrate-database.ts")
        console.log()

    } catch (error) {
        console.error("❌ Error during metadata update:", error)
        throw error
    } finally {
        await db.destroy()
    }
}

main().catch((error) => {
    console.error("Fatal error:", error)
    process.exit(1)
})
