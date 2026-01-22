
import { ExecArgs } from "@medusajs/framework/types"

export default async function findLinkTables({ container }: ExecArgs) {
    try {
        const knex = container.resolve("pg_connection")
        console.log("🔍 Searching for Link Tables...")

        const res = await knex.raw(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'link_%'
        `)

        console.error(`Found ${res.rows.length} link tables.`)
        res.rows.forEach((r: any) => {
            if (r.table_name.includes("attr") || r.table_name.includes("prod")) {
                console.error(`   - ${r.table_name}`)
            }
        })

    } catch (e) {
        console.error("Error:", e)
    }
}
