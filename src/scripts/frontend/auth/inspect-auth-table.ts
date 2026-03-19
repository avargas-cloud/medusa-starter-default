import { loadEnv } from "@medusajs/utils"
import postgres from 'postgres'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const sql = postgres(process.env.DATABASE_URL!)

async function inspectAuthTable() {
    console.log('🔍 Inspecting auth_identity table structure...\n')

    try {
        // Get table columns
        const columns = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'auth_identity'
            ORDER BY ordinal_position
        `

        console.log('📋 Table columns:')
        columns.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type})`)
        })

        console.log('\n🔍 Sample records:')
        const sample = await sql`
            SELECT * FROM auth_identity
            LIMIT 3
        `

        console.log(JSON.stringify(sample, null, 2))

    } catch (error) {
        console.error('❌ Error:', error)
    } finally {
        await sql.end()
    }
}

inspectAuthTable()
