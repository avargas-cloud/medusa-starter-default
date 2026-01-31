/**
 * Emergency Check: Verify Product Attributes After Migration
 */

import dotenv from "dotenv"
dotenv.config()

import knex from "knex"

const DB_URL = process.env.DATABASE_URL!

async function main() {
    const db = knex({
        client: "pg",
        connection: DB_URL,
    })

    try {
        console.log("🔍 Checking for attribute-related tables...\n")

        // 1. List all tables with 'attribute' in the name
        const tables = await db.raw(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%attribute%'
            ORDER BY table_name
        `)

        console.log("Tables found:")
        tables.rows.forEach((row: any) => {
            console.log(`  - ${row.table_name}`)
        })
        console.log()

        // 2. Check each attribute table for data
        for (const row of tables.rows) {
            const tableName = row.table_name

            try {
                const count = await db(tableName).count("* as count").first()
                console.log(`${tableName}: ${count?.count} records`)

                // Show structure
                const columns = await db.raw(`
                    SELECT column_name, data_type 
                    FROM information_schema.columns 
                    WHERE table_name = '${tableName}'
                    ORDER BY ordinal_position
                `)

                console.log("  Columns:")
                columns.rows.forEach((col: any) => {
                    console.log(`    - ${col.column_name} (${col.data_type})`)
                })
                console.log()

            } catch (error) {
                console.log(`  Error querying ${tableName}:`, error)
            }
        }

        // 3. Check product_variant structure
        console.log("\n🔍 Checking product_variant structure...\n")
        const variantColumns = await db.raw(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'product_variant'
            ORDER BY ordinal_position
        `)

        console.log("product_variant columns:")
        variantColumns.rows.forEach((col: any) => {
            console.log(`  - ${col.column_name} (${col.data_type})`)
        })

        // 4. Sample a product with variants
        console.log("\n🔍 Sampling product with variants...\n")
        const sampleProduct = await db("product")
            .select("id", "title")
            .first()

        if (sampleProduct) {
            console.log(`Sample product: ${sampleProduct.title} (${sampleProduct.id})`)

            const variants = await db("product_variant")
                .where("product_id", sampleProduct.id)
                .select("*")
                .limit(5)

            console.log(`\nVariants for this product: ${variants.length}`)
            variants.forEach((v, idx) => {
                console.log(`\nVariant ${idx + 1}:`)
                console.log(`  ID: ${v.id}`)
                console.log(`  SKU: ${v.sku}`)
                console.log(`  Title: ${v.title}`)
                console.log(`  Product ID: ${v.product_id}`)
                console.log(`  Metadata: ${JSON.stringify(v.metadata, null, 2)}`)
            })
        }

    } catch (error) {
        console.error("Error:", error)
        throw error
    } finally {
        await db.destroy()
    }
}

main()
