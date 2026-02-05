import postgres from 'postgres'
import { loadEnv } from '@medusajs/framework/utils'

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function checkSchema() {
    const cols = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'auth_identity' 
        ORDER BY ordinal_position
    `

    console.log('auth_identity columns:')
    cols.forEach((c: any) => console.log('  -', c.column_name, ':', c.data_type))

    const records = await sql`SELECT * FROM auth_identity LIMIT 1`
    if (records.length > 0) {
        console.log('\nSample record:', JSON.stringify(records[0], null, 2))
    }

    await sql.end()
}

checkSchema()
