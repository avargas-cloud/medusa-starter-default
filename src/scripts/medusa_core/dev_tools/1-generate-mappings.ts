/**
 * Phase 1: Generate Product ID Mappings
 * 
 * Purpose:
 * - Generate new ULID-format IDs for all handle-based product IDs
 * - Create mapping table in database
 * - Export mappings to JSON for backup
 * 
 * Usage:
 *   npx tsx scripts/product-id-migration/1-generate-mappings.ts
 */

import dotenv from "dotenv"
dotenv.config()

import { generateEntityId } from "@medusajs/framework/utils"
import { MedusaModule } from "@medusajs/framework/modules-sdk"
import knex from "knex"
import fs from "fs"
import path from "path"

const DB_URL = process.env.DATABASE_URL!

async function main() {
    console.log("🚀 Product ID Migration - Phase 1: Generate Mappings\n")

    // 1. Connect to database
    const db = knex({
        client: "pg",
        connection: DB_URL,
    })

    try {
        // 2. Check if migration table already exists
        const tableExists = await db.schema.hasTable("product_id_migration")

        if (tableExists) {
            console.log("⚠️  Migration table already exists!")
            const { confirm } = await import("readline/promises").then(m => m.createInterface({
                input: process.stdin,
                output: process.stdout
            })).then(rl => rl.question("Drop and recreate? (yes/no): ").then(answer => {
                rl.close()
                return { confirm: answer.toLowerCase() === "yes" }
            }))

            if (!confirm) {
                console.log("❌ Aborted by user")
                process.exit(0)
            }

            await db.schema.dropTable("product_id_migration")
            console.log("✅ Dropped existing table\n")
        }

        // 3. Create migration table
        console.log("📋 Creating migration table...")
        await db.schema.createTable("product_id_migration", (table) => {
            table.string("old_id", 255).primary()
            table.string("new_id", 255).notNullable().unique()
            table.string("handle", 255).notNullable()
            table.text("title")
            table.timestamp("migrated_at").defaultTo(db.fn.now())
        })
        console.log("✅ Migration table created\n")

        // 4. Fetch all products with handle-based IDs
        console.log("🔍 Fetching products with handle-based IDs...")
        const products = await db("product")
            .select("id", "handle", "title")
            .where("id", "like", "prod_%-%") // Handle-based format
            .orderBy("handle")

        console.log(`📦 Found ${products.length} products to migrate\n`)

        if (products.length === 0) {
            console.log("ℹ️  No products need migration (all IDs are already ULID format)")
            await db.destroy()
            return
        }

        // 5. Generate new IDs and create mappings
        console.log("🔄 Generating new ULIDs...")
        const mappings: Array<{
            old_id: string
            new_id: string
            handle: string
            title: string | null
        }> = []

        const usedIds = new Set<string>()

        for (const product of products) {
            // Generate new ULID
            let newId = generateEntityId("", "product")

            // Ensure uniqueness (extremely rare collision but be safe)
            while (usedIds.has(newId)) {
                newId = generateEntityId("", "product")
            }
            usedIds.add(newId)

            mappings.push({
                old_id: product.id,
                new_id: newId,
                handle: product.handle,
                title: product.title
            })
        }

        console.log(`✅ Generated ${mappings.length} new ULIDs\n`)

        // 6. Insert mappings into database
        console.log("💾 Inserting mappings into database...")
        await db("product_id_migration").insert(mappings)
        console.log("✅ Mappings saved to database\n")

        // 7. Export mappings to JSON file
        const outputPath = path.join(process.cwd(), "scripts/product-id-migration/mappings.json")
        console.log(`📄 Exporting mappings to ${outputPath}...`)

        fs.writeFileSync(
            outputPath,
            JSON.stringify(mappings, null, 2),
            "utf-8"
        )
        console.log("✅ Mappings exported\n")

        // 8. Display sample mappings
        console.log("📊 Sample Mappings (first 5):")
        console.log("─".repeat(80))
        mappings.slice(0, 5).forEach(m => {
            console.log(`${m.old_id}`)
            console.log(`  → ${m.new_id}`)
            console.log(`  Handle: ${m.handle}`)
            console.log(`  Title: ${m.title}`)
            console.log()
        })

        // 9. Summary
        console.log("─".repeat(80))
        console.log("✅ PHASE 1 COMPLETE\n")
        console.log("Summary:")
        console.log(`  - Products to migrate: ${mappings.length}`)
        console.log(`  - Mapping table: product_id_migration`)
        console.log(`  - Backup file: ${outputPath}`)
        console.log()
        console.log("Next steps:")
        console.log("  1. Review mappings.json")
        console.log("  2. Run: node scripts/product-id-migration/2-update-metadata.ts")
        console.log()

    } catch (error) {
        console.error("❌ Error during migration:", error)
        throw error
    } finally {
        await db.destroy()
    }
}

main().catch((error) => {
    console.error("Fatal error:", error)
    process.exit(1)
})
