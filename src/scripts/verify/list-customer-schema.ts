import 'dotenv/config'
import postgres from 'postgres'

async function listAllCustomerColumns() {
    const sql = postgres(process.env.DATABASE_URL!)

    console.log('\n📋 FULL CUSTOMER TABLE SCHEMA:\n')

    try {
        const columns = await sql`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'customer'
            ORDER BY ordinal_position
        `

        console.log('Total columns:', columns.length)
        console.log('\nAll columns:')
        columns.forEach((col, i) => {
            console.log(`${i + 1}. ${col.column_name} (${col.data_type}) ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`)
        })

        // Check specifically for address-related fields
        console.log('\n🔍 Address-related fields:')
        const addressFields = columns.filter(c =>
            c.column_name.includes('address') ||
            c.column_name.includes('billing') ||
            c.column_name.includes('shipping')
        )

        if (addressFields.length === 0) {
            console.log('   ❌ NO address-related fields found!')
        } else {
            addressFields.forEach(f => {
                console.log(`   ✅ ${f.column_name} (${f.data_type})`)
            })
        }

    } catch (error) {
        console.error('Error:', error)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

listAllCustomerColumns()
