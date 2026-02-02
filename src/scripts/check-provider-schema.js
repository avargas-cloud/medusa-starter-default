import { Client } from 'pg'
import 'dotenv/config'

const checkSchema = async () => {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        // Get table structure
        const columns = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'provider_identity'
            ORDER BY ordinal_position
        `)

        console.log('📋 PROVIDER_IDENTITY TABLE STRUCTURE:\n')
        columns.rows.forEach(col => {
            console.log(`   ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${col.is_nullable}`)
        })

        // Check actual data for alejosvp
        console.log('\n\n🔍 ACTUAL DATA FOR alejosvp@gmail.com:\n')
        const data = await client.query(`
            SELECT id, entity_id, provider, user_metadata, auth_metadata, provider_metadata
            FROM provider_identity 
            WHERE entity_id = 'alejosvp@gmail.com'
        `)

        if (data.rows.length > 0) {
            const row = data.rows[0]
            console.log('ID:', row.id)
            console.log('Provider:', row.provider)
            console.log('\nuser_metadata:', JSON.stringify(row.user_metadata, null, 2))
            console.log('\nauth_metadata:', JSON.stringify(row.auth_metadata, null, 2))
            console.log('\nprovider_metadata:', JSON.stringify(row.provider_metadata, null, 2))
        } else {
            console.log('No data found')
        }

    } catch (error) {
        console.error('Error:', error.message)
    } finally {
        await client.end()
    }
}

checkSchema()
