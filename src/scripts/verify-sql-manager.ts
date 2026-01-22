
import { ExecArgs } from "@medusajs/framework/types"

export default async function verifySqlManager({ container }: ExecArgs) {
    try {
        console.log("🔍 Resolving EntityManager...")
        const manager = container.resolve("manager")

        console.log("   ✅ Manager resolved. Querying tables...")

        // Postgres query to list tables
        const query = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND (table_name LIKE 'link_%' OR table_name LIKE '%attribute%')
        `

        const result = await manager.execute(query)
        console.log(`   Found ${result.length} tables:`)
        result.forEach((r: any) => console.log(`   - ${r.table_name}`))

        // Find the best candidate
        const linkTable = result.find((r: any) =>
            r.table_name.startsWith("link_") && r.table_name.includes("product") && r.table_name.includes("attr")
        )

        if (linkTable) {
            console.log(`\n🎯 Querying table: ${linkTable.table_name}`)
            const rows = await manager.execute(`SELECT * FROM ${linkTable.table_name} LIMIT 5`)
            console.log(`   Rows found: ${rows.length}`)
            if (rows.length > 0) {
                console.log("   DATA:", JSON.stringify(rows, null, 2))
            } else {
                console.log("   ❌ Table exists but is EMPTY.")
            }

            // Try specific product
            const prodId = "prod_100w-indoor-meanwell-power-supply-24vdc"
            console.log(`\n🔎 Checking for specific product: ${prodId}`)
            const specific = await manager.execute(`SELECT * FROM ${linkTable.table_name} WHERE product_id = '${prodId}'`)
            console.log(`   Match Count: ${specific.length}`)
            if (specific.length > 0) console.log("   MATCH DATA:", JSON.stringify(specific[0], null, 2))

        } else {
            console.log("   ❌ No 'link_product_...attribute...' table found.")
        }

    } catch (e) {
        console.error("❌ SQL Error:", e)
    }
}
