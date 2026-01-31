/**
 * EMERGENCY FIX: Update Product Attributes with New IDs
 * 
 * The table product_product_productattributes_attribute_value was NOT updated
 * by CASCADE during migration because it lacks a proper foreign key constraint.
 * 
 * This script fixes the product_id references in that table.
 */

import dotenv from "dotenv"
dotenv.config()

import knex from "knex"

const DB_URL = process.env.DATABASE_URL!

async function main() {
    console.log("🚨 EMERGENCY FIX: Updating Product Attributes\n")

    const db = knex({
        client: "pg",
        connection: DB_URL,
    })

    try {
        // 1. Check current state
        console.log("📊 Checking current state...\n")

        const totalAttributes = await db("product_product_productattributes_attribute_value")
            .count("* as count")
            .first()

        console.log(`Total attribute records: ${totalAttributes?.count}`)

        // Check how many have old IDs
        const oldIdCount = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_product_productattributes_attribute_value
            WHERE product_id LIKE 'prod_%-%'
        `)

        console.log(`Records with old IDs: ${oldIdCount.rows[0].count}`)
        console.log()

        if (Number(oldIdCount.rows[0].count) === 0) {
            console.log("✅ All attributes already have new IDs!")
            await db.destroy()
            return
        }

        // 2. Verify mapping table exists
        const mappingCount = await db("product_id_migration").count("* as count").first()
        console.log(`Mapping table entries: ${mappingCount?.count}\n`)

        // 3. Update attribute product_ids
        console.log("🔄 Updating product_id references in attributes table...\n")

        const result = await db.raw(`
            UPDATE product_product_productattributes_attribute_value pa
            SET product_id = m.new_id
            FROM product_id_migration m
            WHERE pa.product_id = m.old_id
        `)

        console.log(`✅ Updated ${result.rowCount} attribute records\n`)

        // 4. Verify
        console.log("🔍 Verifying fix...\n")

        const remainingOld = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_product_productattributes_attribute_value
            WHERE product_id LIKE 'prod_%-%'
        `)

        if (Number(remainingOld.rows[0].count) > 0) {
            console.log(`⚠️  WARNING: ${remainingOld.rows[0].count} records still have old IDs`)
        } else {
            console.log("✅ All attribute records now have new product IDs!")
        }

        // 5. Sample check
        console.log("\n📋 Sample attribute records:\n")
        const samples = await db("product_product_productattributes_attribute_value")
            .join("product", "product_product_productattributes_attribute_value.product_id", "product.id")
            .select(
                "product_product_productattributes_attribute_value.id",
                "product_product_productattributes_attribute_value.product_id",
                "product.title",
                "product_product_productattributes_attribute_value.attribute_value_id"
            )
            .limit(5)

        samples.forEach((s, idx) => {
            console.log(`${idx + 1}. ${s.title}`)
            console.log(`   Product ID: ${s.product_id}`)
            console.log(`   Attribute Value ID: ${s.attribute_value_id}`)
            console.log()
        })

        console.log("─".repeat(80))
        console.log("✅ EMERGENCY FIX COMPLETE\n")
        console.log("Summary:")
        console.log(`  - Attribute records updated: ${result.rowCount}`)
        console.log(`  - Records with old IDs remaining: ${remainingOld.rows[0].count}`)
        console.log()
        console.log("Next steps:")
        console.log("  1. Refresh Admin UI")
        console.log("  2. Verify product attributes are visible")
        console.log()

    } catch (error) {
        console.error("❌ Fix failed:", error)
        throw error
    } finally {
        await db.destroy()
    }
}

main().catch((error) => {
    console.error("Fatal error:", error)
    process.exit(1)
})
