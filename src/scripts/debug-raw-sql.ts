
import { ExecArgs } from "@medusajs/framework/types"

export default async function debugRawSQL({ container }: ExecArgs) {
    try {
        console.log("🔍 Attempting to resolve pg_connection...")
        const knex = container.resolve("pg_connection")

        console.log("   ✅ Connection resolved.")

        // 1. List potential link tables
        const tables = await knex.raw(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND (table_name LIKE '%attribute%' OR table_name LIKE '%link%')
        `)

        console.log(`   Found ${tables.rows.length} relevant tables:`)
        tables.rows.forEach((r: any) => console.log(`   - ${r.table_name}`))

        // 2. Identify likely link table for Product <-> AttributeValue
        // usually named "product_product_attributes_attribute_value" or similar
        const linkTable = tables.rows.find((r: any) =>
            r.table_name.includes("product") && r.table_name.includes("attribute")
        )

        if (linkTable) {
            const tableName = linkTable.table_name
            console.log(`\n🎯 Querying likely link table: ${tableName}`)

            const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

            // Check if 'product_id' column exists or if it uses a join key
            const rows = await knex(tableName).limit(5)
            const columns = rows.length > 0 ? Object.keys(rows[0]) : []
            console.log(`   Columns: ${columns.join(", ")}`)

            if (columns.includes("product_id")) {
                const match = await knex(tableName).where({ product_id: productId })
                console.log(`   ✅ Rows for Target Product: ${match.length}`)
                if (match.length > 0) console.log("   Dump:", JSON.stringify(match[0], null, 2))
            } else {
                console.log("   ⚠️ 'product_id' column not found. Inspect columns above.")
            }
        } else {
            console.log("   ❌ No obvious link table found.")
        }

    } catch (e) {
        console.error("❌ SQL Logic Failed:", e)
    }
}
