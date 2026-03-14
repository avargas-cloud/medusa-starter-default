/**
 * Phase 3: Migrate Database Product IDs
 * 
 * Purpose:
 * - Update product table IDs from handle-based to ULID format
 * - Atomic transaction (all-or-nothing)
 * - Foreign keys auto-update via CASCADE
 * 
 * ⚠️  CRITICAL: This modifies the database!
 * - Full backup recommended before running
 * - Phases 1 & 2 must be complete
 * - Test on staging/local first
 * 
 * Usage:
 *   npx tsx scripts/product-id-migration/3-migrate-database.ts
 */

import dotenv from "dotenv"
dotenv.config()

import knex from "knex"
import readline from "readline/promises"

const DB_URL = process.env.DATABASE_URL!

async function confirmMigration(): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })

    console.log("\n⚠️  WARNING: This will modify the database!\n")
    console.log("This script will:")
    console.log("  - Update product IDs from handle-based to ULID format")
    console.log("  - Auto-update all foreign key relationships")
    console.log("  - Execute in a single atomic transaction\n")
    console.log("Prerequisites:")
    console.log("  ✅ Phase 1 complete (mappings generated)")
    console.log("  ✅ Phase 2 complete (metadata updated)")
    console.log("  ✅ Full database backup created\n")

    const answer = await rl.question("Continue with migration? (type 'yes' to proceed): ")
    rl.close()

    return answer.toLowerCase() === "yes"
}

async function main() {
    console.log("🚀 Product ID Migration - Phase 3: Database Migration\n")

    // Confirm before proceeding
    const confirmed = await confirmMigration()
    if (!confirmed) {
        console.log("\n❌ Migration cancelled by user")
        process.exit(0)
    }

    const db = knex({
        client: "pg",
        connection: DB_URL,
    })

    try {
        // 1. Verify mappings exist
        console.log("\n📋 Verifying mappings...")
        const mappingCount = await db("product_id_migration").count("* as count").first()

        if (!mappingCount || Number(mappingCount.count) === 0) {
            console.log("❌ No mappings found! Run Phase 1 first.")
            process.exit(1)
        }

        console.log(`✅ Found ${mappingCount.count} mappings\n`)

        // 2. Check for products that need migration
        console.log("🔍 Checking products...")
        const productsToMigrate = await db("product")
            .where("id", "like", "prod_%-%")
            .count("* as count")
            .first()

        console.log(`📦 Products to migrate: ${productsToMigrate?.count || 0}\n`)

        if (!productsToMigrate || Number(productsToMigrate.count) === 0) {
            console.log("ℹ️  No products need migration (already ULID format)")
            await db.destroy()
            return
        }

        // 3. Execute migration in transaction
        console.log("🔄 Starting database migration...")
        console.log("   (This may take a few seconds)\n")

        const migrationStart = Date.now()
        let rowCount = 0

        await db.transaction(async (trx) => {
            // Disable triggers for performance  (optional)
            // await trx.raw("SET session_replication_role = 'replica'")

            // Update product IDs using mapping table
            const result = await trx.raw(`
                UPDATE product p
                SET id = m.new_id
                FROM product_id_migration m
                WHERE p.id = m.old_id
            `)

            rowCount = result.rowCount
            console.log(`✅ Updated ${rowCount} product IDs`)

            // Re-enable triggers
            // await trx.raw("SET session_replication_role = 'origin'")

            // Postgres CASCADE will auto-update:
            // - product_variant.product_id
            // - product_image.product_id
            // - product_option.product_id
            // - product_category_product.product_id
            // - product_sales_channel.product_id
            // - product_tag_product.product_id
            // - etc.
        })

        const migrationTime = Date.now() - migrationStart
        console.log(`⏱️  Migration completed in ${migrationTime}ms\n`)

        // 4. Verify migration
        console.log("🔍 Verifying migration...")

        // Check: All products should now have ULID format
        const oldFormatCount = await db("product")
            .where("id", "like", "prod_%-%")
            .count("* as count")
            .first()

        if (oldFormatCount && Number(oldFormatCount.count) > 0) {
            console.log(`❌ ERROR: ${oldFormatCount.count} products still have old format IDs!`)
            console.log("   This should not happen. Check transaction logs.")
            process.exit(1)
        }

        console.log("✅ All products have ULID format IDs")

        // Check: No orphaned variants
        const orphanedVariants = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_variant pv
            LEFT JOIN product p ON pv.product_id = p.id
            WHERE p.id IS NULL
        `)

        if (Number(orphanedVariants.rows[0].count) > 0) {
            console.log(`❌ ERROR: ${orphanedVariants.rows[0].count} orphaned variants found!`)
            console.log("   Foreign key CASCADE may have failed.")
            process.exit(1)
        }

        console.log("✅ All variants linked correctly")

        // Check: No orphaned categories
        const orphanedCategories = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_category_product pcp
            LEFT JOIN product p ON pcp.product_id = p.id
            WHERE p.id IS NULL
        `)

        if (Number(orphanedCategories.rows[0].count) > 0) {
            console.log(`❌ ERROR: ${orphanedCategories.rows[0].count} orphaned category links found!`)
            process.exit(1)
        }

        console.log("✅ All category links valid")

        // 5. Get sample of migrated products
        console.log("\n📊 Sample Migrated Products (first 5):")
        console.log("─".repeat(80))

        const sampleProducts = await db("product")
            .join("product_id_migration as m", "product.id", "m.new_id")
            .select("product.id as new_id", "m.old_id", "product.handle", "product.title")
            .limit(5)

        sampleProducts.forEach(p => {
            console.log(`${p.old_id}`)
            console.log(`  → ${p.new_id}`)
            console.log(`  Handle: ${p.handle}`)
            console.log(`  Title: ${p.title}`)
            console.log()
        })

        // 6. Summary
        console.log("─".repeat(80))
        console.log("✅ PHASE 3 COMPLETE\n")
        console.log("Summary:")
        console.log(`  - Products migrated: ${rowCount}`)
        console.log(`  - Migration time: ${migrationTime}ms`)
        console.log(`  - Orphaned variants: 0`)
        console.log(`  - Orphaned categories: 0`)
        console.log()
        console.log("Next steps:")
        console.log("  1. Test Admin UI (products, variants, sorting)")
        console.log("  2. Test Storefront (product pages, categories)")
        console.log("  3. Run: npx tsx scripts/product-id-migration/4-verify-migration.ts")
        console.log("  4. Re-index MeiliSearch if needed")
        console.log()
        console.log("⚠️  Keep 'product_id_migration' table for 30 days as rollback reference")
        console.log()

    } catch (error) {
        console.error("\n❌ Migration failed:", error)
        console.error("\n⚠️  Transaction was rolled back. Database unchanged.")
        throw error
    } finally {
        await db.destroy()
    }
}

main().catch((error) => {
    console.error("Fatal error:", error)
    process.exit(1)
})
